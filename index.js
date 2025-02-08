import { promises as fs } from 'fs';
import path from 'path';
import _ from 'lodash';
import resolve from 'resolve';
import { readPackageUpSync } from 'read-package-up';

function splitLast(str, separator) {
  const lastIndex = str.lastIndexOf(separator);
  return [
    lastIndex === -1 ? null : str.substring(0, lastIndex),
    lastIndex === -1 ? str : str.substring(lastIndex + separator.length),
  ];
}

const trimStart = (str, starting) => (str && str.startsWith(starting) ? str.substring(starting.length) : str);

const isLocalModule = (subModule) => subModule.importPath.startsWith('.') || subModule.importPath.startsWith('/');

/**
 * Vite plugin to generate routes based on the file system structure.
 */
export default function generateRoutesPlugin(options = {}) {
  const {
    root = 'src', // Default to 'src' if not specified
    routesDir = 'pages',
    subRouters,
    enabled = true,
  } = options;

  const rootPath = path.resolve(root);

  const moduleMap = {};
  let routesPattern = routesDir.startsWith('/') ? routesDir : `/${routesDir}`;
  routesPattern = routesPattern.endsWith('/') ? routesPattern : `${routesPattern}/`;

  /**
   * Recursively build routes from the directory structure.
   */
  async function buildRoutes(rootDir, currentDir, isRoot, parentPath = '/', nodeModule) {
    let entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries = entries.sort((a, b) =>
      a.name < b.name || b.name.startsWith('_any.') ? -1 : a.name > b.name || a.name.startsWith('_any.') ? 1 : 0
    );

    let routes = [];

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      const routePath = buildRoutePath(entry.name, parentPath);

      if (entry.isDirectory()) {
        // Handle route groups (pattern to exclude from URL path)
        if (isRouteGroup(entry.name)) {
          const children = await buildRoutes(rootDir, fullPath, isRoot, parentPath, nodeModule);
          routes = routes.concat(children);
        } else {
          const children = await buildRoutes(rootDir, fullPath, isRoot, routePath, nodeModule);
          routes.push({
            path: routePath,
            children,
          });
        }
      } else if (entry.isFile() && isRouteFile(entry.name)) {
        const isLoader = entry.name.endsWith('.loader_.js');
        const isAnyDeeper = entry.name.startsWith('_any.');
        const isLazy = entry.name.endsWith('.lazy_.jsx');
        const isIndex = entry.name.startsWith('index.');
        const isLayout = entry.name.startsWith('_layout.');
        const isError = entry.name.startsWith('_error.');

        let componentName = generateComponentName(relativePath, isLoader);
        if (isError) {
          componentName += 'Boundary';
        }

        if (isIndex) {
          if (entry.name !== 'index.jsx' && entry.name !== 'index.lazy_.jsx' && entry.name !== 'index.loader_.js') {
            throw new Error(`Index route does not support flat mode. File: ${fullPath}`);
          }
        }

        if (isAnyDeeper) {
          if (isLoader) {
            throw new Error(`"/*" route does not support loader. File: ${fullPath}`);
          }
        }

        if (isLayout && isLazy) {
          throw new Error(
            `Layout route does not support lazy, you can use a lazy sub-module instead. File: ${fullPath}`
          );
        }

        let importPath =
          (nodeModule ? subRouters[nodeModule].importPath : '.') +
          `/${path.join(routesDir, relativePath).replace(/\\/g, '/')}`;
        if (importPath.endsWith('.jsx')) {
          importPath = importPath.slice(0, -4);
        } else if (importPath.endsWith('.js')) {
          importPath = importPath.slice(0, -3);
        }

        const route = {
          path: isAnyDeeper ? routePath + (routePath.endsWith('/') ? '*' : '/*') : isIndex ? parentPath : routePath,
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

  async function buildRoutesFromDirectory(sourcePath, isRoot, nodeModule) {
    const routesPath = path.resolve(sourcePath, routesDir);
    moduleMap[routesPath] = { sourcePath, isRoot, key: nodeModule };

    const outputFile = isRoot
      ? path.resolve(sourcePath, 'routes.runtime.jsx')
      : nodeModule
        ? path.resolve(rootPath, `sub-routes-${_.kebabCase(nodeModule)}.runtime.jsx`)
        : path.resolve(sourcePath, 'sub-routes.runtime.jsx');

    const routes = await buildRoutes(routesPath, routesPath, isRoot, '/', nodeModule);
    //console.dir(routes, { depth: null });

    const fileContent = generateRoutesFileContent(routes, isRoot ? subRouters : undefined, isRoot);

    await fs.writeFile(outputFile, fileContent, 'utf-8');
    console.log(`Generated ${outputFile}`);
  }

  return {
    name: 'vite-plugin-file-based-react-router',
    async buildStart() {
      if (!enabled) {
        return;
      }

      await buildRoutesFromDirectory(root, true);

      for (let key in subRouters) {
        const routeInfo = subRouters[key];

        let importPath;
        let nodeModule;

        if (isLocalModule(routeInfo)) {
          importPath = path.join(root, routeInfo.importPath);
        } else {
          const mainFile = resolve.sync(routeInfo.importPath, { basedir: rootPath });
          const { path: pkgJsonPath } = readPackageUpSync({ cwd: path.dirname(mainFile) });
          const packageRoot = path.dirname(pkgJsonPath);
          importPath = path.join(packageRoot, root);
          nodeModule = key;
        }

        await buildRoutesFromDirectory(importPath, false, nodeModule);
      }
    },

    async watchChange(id) {
      const pos = id.indexOf(routesPattern);
      if (pos !== -1) {
        const modulePath = id.substring(0, pos + routesPattern.length - 1);
        const mdouleInfo = moduleMap[modulePath];
        if (mdouleInfo != null) {
          await buildRoutesFromDirectory(
            mdouleInfo.sourcePath,
            mdouleInfo.isRoot,
            mdouleInfo.isRoot || isLocalModule(mdouleInfo) ? undefined : mdouleInfo.key
          );
        }
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
  routeSegment = routeSegment.replace(/\.loader_\.js$/, '');
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
  return name.endsWith('.jsx') || name.endsWith('.loader_.js');
}

/**
 * Generate a unique component name based on the file path.
 */
function generateComponentName(relativePath, isLoader) {
  let componentName = relativePath
    .replace(/[\/\\]/g, '_')
    .replace(/\.lazy_\.jsx$/, '')
    .replace(/\.jsx$/, '')
    .replace(/\.js$/, '')
    //.replace(/_any$/, '')
    .replace(/\[(.+?)\]/g, '$1')
    .replace(/[^a-zA-Z0-9_]/g, '');

  componentName = _.camelCase(componentName);

  if (isLoader) {
    return componentName;
  }

  return _.upperFirst(componentName);
}

const KEY_ORDERS = ['index', 'path', 'element', 'errorElement', 'loader', 'handle', 'lazy'];

function tidyRoutes(routes, isRoot, parentPath = '/') {
  if (typeof routes === 'string') return routes;

  return routes
    .map((route) => {
      // reorder properties
      const orderedRoute = {};
      for (const key of KEY_ORDERS) {
        if (key in route) {
          orderedRoute[key] = route[key];
          if (!isRoot && key === 'path') {
            orderedRoute[key] = trimStart(orderedRoute[key], '/');
          }
        }
      }

      if (route.children && route.children.length > 0) {
        // for path only routes, move children to parent
        if (Object.keys(orderedRoute).length === 1 && 'path' in orderedRoute) {
          const [onlyChild] = tidyRoutes(route.children, isRoot);
          if (onlyChild.index) {
            delete onlyChild.index;
            onlyChild.path = orderedRoute.path;
          }
          return onlyChild;
        } else {
          orderedRoute.children = tidyRoutes(route.children, isRoot, route.path);
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

    if (start === '/') {
      return '/';
    }

    let [parentPath] = splitLast(start, '/');
    if (!parentPath) {
      parentPath = '/';
    }

    return findNearestParent(parentPath);
  }

  function processRoutes(routes) {
    const routeDefinitions = [];
    const _deferred = [];

    for (const route of routes) {
      const routeDef = {};
      let merged = false;
      let isNode = false;

      const { path, element, importPath, isLazy, isLoader, isLayout, isError, isIndex, isAnyDeeper, children } = route;

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
            if (isLazy) {
              lazyImports += `const ${componentName} = React.lazy(() => import('${importPath}'));\n`;
            } else {
              importStatements += `import ${componentName} from '${importPath}';\n`;
            }
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
            importStatements += `import { Component as ${componentName}, handle as ${handleName} } from '${importPath}';\n`;
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
            lazyImports += `const lazy${componentName} = () => import('${importPath}');\n`;
            importSet.add(importPath);
          }
          routeDef.lazy = 'lazy' + componentName;
          isNode = true;
        } else {
          // 普通组件
          const handleName = `handle${componentName}`;
          if (!importSet.has(importPath)) {
            importStatements += `import { Component as ${componentName}, handle as ${handleName} } from '${importPath}';\n`;
            importSet.add(importPath);
          }
          routeDef.element = `<${componentName} />`;
          routeDef.handle = handleName;
          isNode = true;
        }
      }

      // 处理子路由
      if (children && children.length > 0) {
        if (routeMergeMap[routeDef.path]) {
          routeMergeMap[routeDef.path].children = processRoutes(children);
        } else {
          routeMergeMap[routeDef.path] = routeDef;
          const moreChildren = processRoutes(children);
          routeDef.children = [...(routeDef.children || []), ...moreChildren];

          if (!routeMergeMap[parentPath]) {
            _deferred.push({ parentPath, routeDef });
          } else {
            routeMergeMap[parentPath].children = [...(routeMergeMap[parentPath].children || []), routeDef];
          }
        }

        merged = true;
      }

      if (isNode) {
        let p = parentPath;

        if (isIndex) {
          routeDef.index = true;
          p = routeDef.path;
          delete routeDef.path;
        }

        const _parentPath = findNearestParent(p);
        routeMergeMap[_parentPath].children = [...(routeMergeMap[_parentPath].children || []), routeDef];
      } else if (!merged) {
        // 添加到路由定义数组
        routeDefinitions.push(routeDef);
      }
    }

    if (_deferred.length > 0) {
      for (const { parentPath, routeDef } of _deferred) {
        routeMergeMap[parentPath].children = [...(routeMergeMap[parentPath].children || []), routeDef];
      }
    }

    return routeDefinitions;
  }

  const _routes = processRoutes(routes);

  if (subRoutes) {
    for (let _path in subRoutes) {
      const routeInfo = subRoutes[_path];

      const componentName = _.upperFirst(_.camelCase(_path.replace(/\//g, '-'))) + 'Any';
      const importPath =
        './' +
        (isLocalModule(routeInfo)
          ? path.join(routeInfo.importPath, 'sub-routes.runtime')
          : `sub-routes-${_.kebabCase(_path)}.runtime`);

      let routeDef = {
        path: _path,
      };

      if (routeInfo.isLazy) {
        if (!routeInfo.defaultRoute || routeInfo.defaultRoute === '/') {
          throw new Error(`Default route is required for lazy sub-routes: "${_path}" and it should not be "/".`);
        }
        if (!importSet.has('react-router-dom')) {
          importStatements += `import { redirect } from 'react-router-dom';\n`;
          importSet.add('react-router-dom');
        }

        lazyImports += `const lazy${componentName} = () => import('${importPath}');\n`;
        const redirectPath = path.join(_path, routeInfo.defaultRoute).replace(/\\/g, '/');
        routeDef.children = `[{ index: true, loader: () => redirect('${redirectPath}') }]`;
        routeDef.handle = `{ lazyRouting: lazy${componentName} }`;
      } else {
        importStatements += `import ${componentName} from '${importPath}';\n`;
        routeDef.element = `<${componentName} />`;
      }

      importSet.add(importPath);

      if (routeMergeMap[_path]) {
        throw new Error(`Duplicate route path: ${_path}`);
      }

      const _parentPath = findNearestParent(_path);
      routeMergeMap[_parentPath].children = [...(routeMergeMap[_parentPath].children || []), routeDef];
    }
  }

  const routesArray = tidyRoutes(_routes, isRoot);

  // 生成路由配置的字符串表示
  const routeDefsString = JSON.stringify(routesArray, null, 2)
    // 处理 element 属性，移除引号
    .replace(/"element": "(<[^"]+>)"/g, '"element": $1')
    .replace(/"lazy": "([^"]+)"/g, '"lazy": $1')
    // 处理 errorElement 属性
    .replace(/"errorElement": "(<[^"]+>)"/g, '"errorElement": $1')
    // 处理 loader 属性
    .replace(/"loader": "([a-zA-Z0-9_]+)"/g, '"loader": $1')
    // 处理 handle 属性
    .replace(/("handle":\s*)"({[^"]*})"/g, '$1$2')
    .replace(/"handle": "([a-zA-Z0-9_]+)"/g, '"handle": $1')
    // 移除 element 为 null 的情况
    .replace(/"element": null,\n/g, '')
    // 移除 JSX 元素周围的引号
    .replace(/"<([^"]+)>"(?=\s*(,|\}))/g, '$1')
    // 移除 children 为字符串的情况
    .replace(/"children": "([^"]+)"/g, '"children": $1');
  let fileContent;

  if (isRoot) {
    // 生成最终的文件内容
    fileContent = `import React from 'react';
${importStatements}
${lazyImports}
export const lazyRouting = async ({ patch, matches }) => {
  let leafRoute = matches[matches.length - 1]?.route;

  if (leafRoute?.handle?.lazyRouting) {
    const { default: children } = await leafRoute.handle.lazyRouting();
    patch(leafRoute.id, children);
  }
};

const routes = ${routeDefsString};

export default routes;
`;
  } else {
    fileContent = `import React from 'react';
${importStatements}
${lazyImports}
const subRoutes = ${routeDefsString};

export default subRoutes;
`;
  }

  return fileContent;
}
