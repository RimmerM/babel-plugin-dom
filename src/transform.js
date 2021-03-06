const JSX = require("babel-plugin-syntax-jsx");

const NodeFlag = {
  Text: 1,
  Html: 2,
  Fun: 4,
  Class: 8,
  Template: 16,

  KeyedChildren: 32,
  UnkeyedChildren: 64,

  Svg: 128,
  Input: 256,
  TextArea: 512,
};

function getRootNode(node, path) {
  while(path.parentPath) {
    node = path.node;
    path = path.parentPath;
  }

  return {
    node: path.node,
    index: path.node.body.indexOf(node),
  };
}

function addImport(types, options, name, isFactory) {
  const fun = options.pragma && options.pragma[name] || name;
  const imp = isFactory ? options.factoryImport : options.import;

  if(imp) {
    const importsField = isFactory ? "addedFactoryImports" : "addedImports";
    let imports = options[importsField];
    if(!imports) {
      imports = { decl: types.importDeclaration([], types.stringLiteral(imp)), entries: {} };
      options[importsField] = imports;
      
      const { node, index } = getRootNode(options.path.node, options.path.parentPath);
      node.body.splice(index, 0, imports.decl);
    }
    
    if(!imports.entries[fun]) {
      imports.entries[fun] = true;
      imports.decl.specifiers.push(types.ImportSpecifier(types.identifier(fun), types.identifier(fun)));
    }
  }

  return fun;
}

function callCreate(types, options, name, isFactory, args) {
  const fun = addImport(types, options, name, isFactory);
  return types.callExpression(types.identifier(fun), args);
}

function getType(types, options, type) {
  const astType = type.type;
  const name = type.name;

  let flags = 0;
  if(astType === "JSXIdentifier") {
    // Types beginning with a lowercase letter are html, while uppercase letters are components.
    // Since we don't have any additional information about the component types, 
    // those have to be resolved at runtime.
    if(name.charAt(0).toUpperCase() !== name.charAt(0)) {
      // For html types there are some special cases.
      flags = NodeFlag.Html;
      switch(name) {
        case "svg": flags |= NodeFlag.Svg; break;
        case "input": flags |= NodeFlag.Input; break;
        case "textarea": flags |= NodeFlag.TextArea; break;
      }

      const templates = options.templates;
      if(templates && name in templates) {
        flags |= NodeFlag.Template;
      }
    }
  }

  return {
    type: (flags & NodeFlag.Html) ? types.StringLiteral(name) : type,
    flags,
  };
}

function getValue(types, value) {
  if(!value) return types.BooleanLiteral(true);
  if(value.type === "JSXExpressionContainer") return value.expression;
  return value;
}

function getName(types, name) {
  if(name.indexOf("-") !== 0) return types.StringLiteral(name);
  return types.identifier(name);
}

function getProps(types, ast) {
  const props = [];
  let key = null, ref = null, className = null;
  let keyedChildren = false, unkeyedChildren = false;

  for(let i = 0; i < ast.length; i++) {
    const prop = ast[i];
    if(prop.type === "JSXSpreadAttribute") {
      props.push({
        key: null,
        value: null,
        spread: prop.argument,
      });
    } else {
      let name = prop.name;
      const value = prop.value;

      if(name.type === "JSXIdentifier") {
        name = name.name;
      } else if(name.type === "JSXNamespacedName") {
        name = `${name.namespace.name}:${name.name.name}`;
      }

      switch(name) {
        case "className":
        case "class":
          className = getValue(types, value);
          break;
        case "keyedChildren": 
          keyedChildren = true;
          break;
        case "unkeyedChildren":
          unkeyedChildren = true;
          break;
        case "ref":
          ref = getValue(types, value);
          break;
        case "key":
          key = getValue(types, value);
          break;
        default:
          props.push({
            key: getName(types, name),
            value: getValue(types, value),
            spread: null,
          });
      }
    }
  }

  return {
    props: props.length > 0 && types.ObjectExpression(props.map(prop =>
      prop.spread 
        ? types.SpreadProperty(prop.spread)
        : types.ObjectProperty(prop.key, prop.value)
    )) || null,
    key,
    ref,
    className,
    keyedChildren,
    unkeyedChildren,
  };
}

function getChildren(types, options, ast) {
  let children = [];
  let possiblyKeyed = false;

  for(let i = 0; i < ast.length; i++) {
    const child = ast[i];
    const node = createNode(types, options, child);
    if(node) {
      children.push(node);

      if(!possiblyKeyed && child.openingElement) {
        const props = child.openingElement.attributes;

        for(let j = 0; j < props.length; j++) {
          const prop = props[j];

          if(prop.name && prop.name.name === "key") {
            possiblyKeyed = true;
            break;
          }
        }
      }
    }
  }

  const singleChild = children.length === 1;
  if(singleChild) {
    possiblyKeyed = false;
    children = children[0];
  } else if(children.length === 0) {
    children = null;
  }

  return { children, possiblyKeyed };
}

function createNode(types, options, ast) {
  switch(ast.type) {
    case "JSXElement":
      return createElement(types, options, ast);
    case "JSXText":
      return createText(types, options, ast.value);
    case "JSXExpressionContainer":
      return createContainer(types, options, ast);
  }
}

function createElement(types, options, ast) {
  const opening = ast.openingElement;
  const { children, possiblyKeyed } = getChildren(types, options, ast.children);
  let { type, flags } = getType(types, options, opening.name);
  const { props, className, key, ref, keyedChildren, unkeyedChildren } = getProps(types, opening.attributes);

  if(possiblyKeyed || keyedChildren) {
    flags |= NodeFlag.KeyedChildren;
  }

  if(unkeyedChildren) {
    flags |= NodeFlag.UnkeyedChildren;
  }

  const nullArg = types.identifier("null");
  let childArg;
  if(children == null) {
    childArg = nullArg;
  } else if(Array.isArray(children)) {
    childArg = types.arrayExpression(children);
  } else {
    childArg = children;
  }

  let builder;
  let args;
  const isHtml = flags & NodeFlag.Html;
  const factory = isHtml && options.factory && options.factory[type.value];

  if(factory || isHtml) {
    builder = "newHtml";
    flags &= ~NodeFlag.Html;
    args = [
      childArg,
      className != null ? className : nullArg,
      (flags > 0 || props != null || key != null || ref != null) ? types.NumericLiteral(flags) : nullArg,
      props != null ? props : nullArg,
      key != null ? key : nullArg,
      ref != null ? ref : nullArg,
    ];

    if(!factory) args = [type].concat(args);
  } else {
    builder = "newComponent";
    args = [
      type,
      props != null ? props : nullArg,
      childArg,
      (flags > 0 || className != null || key != null || ref != null) ? types.NumericLiteral(flags) : nullArg,
      className != null ? className : nullArg,
      key != null ? key : nullArg,
      ref != null ? ref : nullArg,
    ];
  }

  for(let i = args.length - 1; i >= 0; i--) {
    if(args[i] === nullArg) args.length--;
    else break;
  }

  return callCreate(types, options, factory || builder, !!factory, args);
}

function createText(types, options, text) {
  const lines = text.split(/\r\n|\n|\r/);

  text = lines.map((line, i) => {
    let trimmed = line.replace("\t", " ");
    if(i !== 0) trimmed = trimmed.replace(/^[ ]+/, "");
    if(i !== lines.length - 1) trimmed = trimmed.replace(/[ ]+$/, "");
    return trimmed;
  }).filter(line => line.length > 0).join("");

  return text === "" ? null : types.StringLiteral(text);
}

function createContainer(types, options, ast) {
  const expr = ast.expression;
  return (expr && expr.type !== "JSXEmptyExpression") ? expr : null;
}

module.exports = options => {
  const types = options.types;

  return {
    visitor: {
      JSXElement: {
        enter: (path, state) => {
          state.opts.path = path;
          path.replaceWith(createNode(types, state.opts, path.node));
        }
      }
    },
    inherits: JSX
  }
};