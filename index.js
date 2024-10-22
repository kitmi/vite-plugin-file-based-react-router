import { promises as fs } from 'fs';
import path from 'path';
import _ from 'lodash';

function splitLast(str, separator) {
  const lastIndex = str.lastIndexOf(separator);
  return [
    lastIndex === -1 ? null : str.substring(0, lastIndex),
    lastIndex === -1 ? str : str.substring(lastIndex + separator.length),
  ];
};

const ensureEndsWith = (str, ending) => (str ? (str.endsWith(ending) ? str : str + ending) : ending);

/**
 * Vite plugin to generate routes based on the file system structure.
 */
export default function generateRoutesPlugin(options = {}) {
  const {
    root = 'src', // Default to 'src' if not specified
    routesDir = 'pages',
    subRouters,
  } = options;

  /**
   * Recursively build routes from the directory structure.
   */
  async function buildRoutes(rootDir, currentDir, parentPath = '/') {
    let entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries = entries.sort((a, b) => a.name.localeCompare(b.name));

    let routes = [];

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      const routePath = buildRoutePath(entry.name, parentPath);

      if (entry.isDirectory()) {
        // Handle route groups (pattern to exclude from URL path)
        if (isRouteGroup(entry.name)) {
          const children = await buildRoutes(rootDir, fullPath, parentPath);
          routes = routes.concat(children);
        } else {
          const children = await buildRoutes(rootDir, fullPath, routePath);
          routes.push({
            path: routePath,
            children,
          });
        }
      } else if (entry.isFile() && isRouteFile(entry.name)) {
        const isLoader = entry.name.endsWith('.loader_.jsx');
        const isAnyDeeper = entry.name.startsWith('_any.');
        const componentName = generateComponentName(relativePath, isLoader);
        const isLazy = entry.name.endsWith('.lazy_.jsx');
        const isIndex = entry.name.startsWith('index.');
        const isLayout = entry.name.startsWith('_layout.');
        const isError = entry.name.startsWith('_error.');

        let importPath = `./${path.join(routesDir, relativePath).replace(/\\/g, '/')}`;
        if (importPath.endsWith('.jsx')) {
          importPath = importPath.slice(0, -4);
        }

        const route = {
          path: isIndex ? parentPath : isAnyDeeper ? routePath + '/*' : routePath,
          element: componentName,
          importPath,
          isLoader,
          isLazy,
          isLayout,
          isError,
          isIndex,
          isAnyDeeper,
        };

        routes.push(route);
      }
    }

    return routes;
  }

  async function buildRoutesFromDirectory(sourcePath, isRoot) {
    const routesPath = path.resolve(sourcePath, routesDir);
    const outputFile = isRoot
      ? path.resolve(sourcePath, 'routes.runtime.jsx')
      : path.resolve(sourcePath, 'sub-routes.runtime.jsx');

    const routes = await buildRoutes(routesPath, routesPath);
    //console.dir(routes, { depth: null });

    const fileContent = generateRoutesFileContent(routes, isRoot ? subRouters : undefined, isRoot);

    await fs.writeFile(outputFile, fileContent, 'utf-8');
    console.log(`Generated ${outputFile}`);
  }

  return {
    name: 'vite-plugin-file-based-react-router',
    async buildStart() {
      await buildRoutesFromDirectory(root, true);

      for (let key in subRouters) {
        const routeInfo = subRouters[key];
        await buildRoutesFromDirectory(path.join(root, routeInfo.importPath), false);
      }
    },
  };
}

/**
 * Generate the route path based on file or directory name.
 */
function buildRoutePath(name, parentPath) {
  let routeSegment = name;

  // Remove file extension
  routeSegment = routeSegment.replace(/\.lazy_\.jsx$/, '');
  routeSegment = routeSegment.replace(/\.loader_\.jsx$/, '');
  routeSegment = routeSegment.replace(/\.jsx$/, '');

  // Handle special files
  if (routeSegment === 'index') {
    return parentPath;
  }
  if (routeSegment === '_layout' || routeSegment === '_error' || routeSegment === '_any') {
    return parentPath;
  }

  // Handle parameterized routes
  routeSegment = routeSegment.replace(/\[(.+?)\]/g, ':$1');

  // Handle nested routes using '.'
  routeSegment = routeSegment.replace(/\./g, '/');

  // Build the full route path
  const fullPath = path.posix.join(parentPath, routeSegment);
  return fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
}

/**
 * Check if a folder is a route group (pattern to exclude from URL path).
 */
function isRouteGroup(name) {
  // Implement pattern matching for route groups if needed
  // For example, folders wrapped with parentheses are route groups
  return /^\(.*\)$/.test(name);
}

/**
 * Check if a file should be treated as a route file.
 */
function isRouteFile(name) {
  return name.endsWith('.jsx');
}

/**
 * Generate a unique component name based on the file path.
 */
function generateComponentName(relativePath, isLoader) {
  let componentName = relativePath
    .replace(/[\/\\]/g, '_')
    .replace(/\.lazy_\.jsx$/, '')
    .replace(/\.jsx$/, '')
    //.replace(/_any$/, '')
    .replace(/\[(.+?)\]/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');

  componentName = _.camelCase(componentName);

  if (isLoader) {
    return componentName;
  }

  return _.upperFirst(componentName);
}

const KEY_ORDERS = ['index', 'path', 'element', 'errorElement', 'loader', 'handle'];

function tidyRoutes(routes, parentPath = '/') {
  return routes
    .map((route) => {
      // reorder properties
      const orderedRoute = {};
      for (const key of KEY_ORDERS) {
        if (key in route) {
          orderedRoute[key] = route[key];
        }
      }

      if (route.children && route.children.length > 0) {
        // for path only routes, move children to parent
        if (Object.keys(orderedRoute).length === 1 && 'path' in orderedRoute) {
          const [onlyChild] = tidyRoutes(route.children);
          if (onlyChild.index) {
            delete onlyChild.index;
            onlyChild.path = orderedRoute.path;
          }
          return onlyChild;
        } else {
          orderedRoute.children = tidyRoutes(route.children, route.path);
        }
      }

      return orderedRoute;
    })
    .sort((a, b) => {
      if (a.index) {
        return -1;
      }

      if (b.index) {
        return 1;
      }

      const trimL = parentPath === '/' ? 1 : parentPath.length + 1;
      let aPath = a.path.substring(trimL);
      let bPath = b.path.substring(trimL);

      if (aPath.startsWith(':') && !bPath.startsWith(':')) {
        return 1;
      }

      if (aPath.indexOf(':') !== -1 && bPath.indexOf(':') === -1) {
        return 1;
      }

      if (bPath.startsWith(':') && !aPath.startsWith(':')) {
        return -1;
      }

      if (bPath.indexOf(':') !== -1 && aPath.indexOf(':') === -1) {
        return -1;
      }

      return 0;
    });
}

function routeToJsx(route, indent) {
  const space = ' '.repeat(indent*2);
  let result = space + '<Route ';
  for (let key in route) {
    if (key === 'children') {
      continue;
    }

    let value = route[key];
    if (typeof value === 'boolean') {
      if (value) {
        result += `${key} `;
      }
    } else if (key === 'element' || key === 'errorElement' || key === 'loader' || key === 'handle') {
      result += `${key}={${value}} `;
    } else {
      result += `${key}="${value}" `;
    }
  }

  if (route.children && route.children.length > 0) {
    result += '>\n';
    result += route.children.map((child) => routeToJsx(child, indent+1)).join('\n');
    result += '\n' + space + '</Route>';
  } else {
    result += '/>';
  }

  return result;
}

/**
 * Generate the content of the routes.runtime.jsx file.
 */
function generateRoutesFileContent(routes, subRoutes, isRoot) {
  let importStatements = '';
  let lazyImports = '';
  const importSet = new Set();
  const routeMergeMap = {};

  function findNearestParent(start) {
    if (routeMergeMap[start]) {
      return start;
    }

    let [parentPath] = splitLast(start, '/');
    if (!parentPath) {
      parentPath = '/';
    }

    return findNearestParent(parentPath);
  }

  function processRoutes(routes) {
    const routeDefinitions = [];

    for (const route of routes) {
      const routeDef = {};
      let merged = false;
      let isNode = false;

      const { path, element, importPath, isLazy, isLoader, isLayout, isError, isIndex, children } = route;

      // 处理路径或索引
      routeDef.path = path;

      let [parentPath] = splitLast(routeDef.path, '/');
      if (!parentPath) {
        parentPath = '/';
      }

      // 处理元素
      if (importPath && element) {
        const componentName = element;

        if (isLoader) {
          // 处理加载器
          if (!importSet.has(importPath)) {
            importStatements += `import ${componentName} from '${importPath}';\n`;
            importSet.add(importPath);
          }
          routeDef.loader = componentName;
          isNode = true;
        } else if (isError) {
          // 处理错误元素
          if (!importSet.has(importPath)) {
            importStatements += `import ${componentName} from '${importPath}';\n`;
            importSet.add(importPath);
          }

          if (routeMergeMap[routeDef.path]) {
            routeMergeMap[routeDef.path].errorElement = `<${componentName} />`;
            merged = true;
          } else {
            // 将 errorElement 分配给当前路由
            routeDef.errorElement = `<${componentName} />`;
            routeMergeMap[routeDef.path] = routeDef;
          }
        } else if (isLayout) {
          // 处理布局和 handle
          const handleName = `handle${componentName}`;
          if (!importSet.has(importPath)) {
            importStatements += `import ${componentName}, { metadata as ${handleName} } from '${importPath}';\n`;
            importSet.add(importPath);
          }

          if (routeMergeMap[routeDef.path]) {
            routeMergeMap[routeDef.path].element = `<${componentName} />`;
            routeMergeMap[routeDef.path].handle = handleName;
            merged = true;
          } else {
            routeDef.element = `<${componentName} />`;
            routeDef.handle = handleName;
            routeMergeMap[routeDef.path] = routeDef;
          }
        } else if (isLazy) {
          // 处理懒加载组件
          if (!importSet.has(importPath)) {
            lazyImports += `const ${componentName} = lazy(() => import('${importPath}'));\n`;
            importSet.add(importPath);
          }
          routeDef.element = `<${componentName} />`;
          isNode = true;
        } else {
          // 普通组件
          if (!importSet.has(importPath)) {
            importStatements += `import ${componentName} from '${importPath}';\n`;
            importSet.add(importPath);
          }
          routeDef.element = `<${componentName} />`;
          isNode = true;
        }
      }

      // 处理子路由
      if (children && children.length > 0) {
        //console.log('children', { path: routeDef.path, pathExist: routeDef.path in routeMergeMap });

        if (routeMergeMap[routeDef.path]) {
          routeMergeMap[routeDef.path].children = processRoutes(children);
        } else {
          routeMergeMap[routeDef.path] = routeDef;
          const moreChildren = processRoutes(children);
          routeDef.children = [...(routeDef.children || []), ...moreChildren];
          //   console.log({
          //     path: routeDef.path,
          //     parentPath,
          //     processedChildren: routeDef.children.length,
          //   });
          //   console.log('push to parent', parentPath, routeMergeMap[parentPath].children);
          routeMergeMap[parentPath].children = [...(routeMergeMap[parentPath].children || []), routeDef];
        }

        merged = true;
      }

      //   console.log({
      //     isNode,
      //     merged,
      //     parentPath,
      //     pathExist: routeDef.path in routeMergeMap,
      //     ...routeDef,
      //   });

      if (isNode) {
        let p = parentPath;

        if (isIndex) {
          routeDef.index = true;
          p = routeDef.path;
          delete routeDef.path;
        }

        const _parentPath = findNearestParent(p);

        //console.log('push to parent 2', _parentPath, routeMergeMap[_parentPath].children);
        routeMergeMap[_parentPath].children = [...(routeMergeMap[_parentPath].children || []), routeDef];
      } else if (!merged) {
        // 添加到路由定义数组
        routeDefinitions.push(routeDef);
      }
    }

    return routeDefinitions;
  }

  const _routes = processRoutes(routes);

  if (subRoutes) {
    for (let _path in subRoutes) {
      const routeInfo = subRoutes[_path];
      if (!_path.endsWith('/*')) {
        _path = ensureEndsWith(_path, '/');
        _path += '*';
      }

      const componentName = _.upperFirst(_.camelCase(_path.replace(/\//g, '-'))) + 'Any';
      const importPath = './' + path.join(routeInfo.importPath, 'sub-routes.runtime');

      let routeDef = {
        path: _path,
        element: `<${componentName} />`,
      };

      if (routeInfo.isLazy) {
        lazyImports += `const ${componentName} = lazy(() => import('${importPath}'));\n`;
      } else {
        importStatements += `import ${componentName} from '${importPath}';\n`;
      }

      importSet.add(importPath);

      if (routeMergeMap[_path]) {
        throw new Error(`Duplicate route path: ${_path}`);
      }

      const _parentPath = findNearestParent(_path);
      routeMergeMap[_parentPath].children = [...(routeMergeMap[_parentPath].children || []), routeDef];
    }
  }

  const routesArray = tidyRoutes(_routes);
  let fileContent;

  if (isRoot) {
    // 生成路由配置的字符串表示

    const routeDefsString = JSON.stringify(routesArray, null, 2)
      // 处理 element 属性，移除引号
      .replace(/"element": "(<[^"]+>)"/g, '"element": $1')
      // 处理 errorElement 属性
      .replace(/"errorElement": "(<[^"]+>)"/g, '"errorElement": $1')
      // 处理 loader 属性
      .replace(/"loader": "([a-zA-Z0-9_]+)"/g, '"loader": $1')
      // 处理 handle 属性
      .replace(/"handle": "([a-zA-Z0-9_]+)"/g, '"handle": $1')
      // 移除 element 为 null 的情况
      .replace(/"element": null,\n/g, '')
      // 移除 JSX 元素周围的引号
      .replace(/"<([^"]+)>"(?=\s*(,|\}))/g, '$1');

    // 生成最终的文件内容
    fileContent = `import { lazy } from 'react';
${importStatements}
${lazyImports}
const routes = ${routeDefsString};

export default routes;
`;
  } else {
    fileContent = `import { lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
${importStatements}
${lazyImports}
const SubRoutes = () => (
  <Routes>
${routesArray.map((route) => routeToJsx(route, 2)).join('\n')}
  </Routes>
);

export default SubRoutes;
`;
  }

  return fileContent;
}
