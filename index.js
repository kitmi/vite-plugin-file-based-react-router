import fsSync, { promises as fs } from 'fs';
import path from 'path';
import _ from 'lodash';
import resolve from 'resolve';
import { readPackageUpSync } from 'read-package-up';

// backward compatibility

const oldAppKeys = {
    loginPage: 'pathLogin',
    landingPage: 'pathLanding',
    errorPage: 'pathError',
    logoutPage: 'pathLogout',
};

function processAppConfig(appConfig) {
    const _result = {};
    _.mapKeys(appConfig, (value, key) => {
        const newKey = oldAppKeys[key] || key;
        if (key !== newKey) {
            console.warn(`"app.${key}" is deprecated, use "app.${newKey}" instead.`);
        }
        _result[newKey] = value;
    });

    return _result;
}

// for grafton-based app only, not mandatory
const graftonAppConfigFile = './grafton-app.json';
const graftonAppLocalConfigFile = './grafton-app.local.json';

function splitLast(str, separator) {
    const lastIndex = str.lastIndexOf(separator);
    return [
        lastIndex === -1 ? null : str.substring(0, lastIndex),
        lastIndex === -1 ? str : str.substring(lastIndex + separator.length),
    ];
}

const trimStart = (str, starting) => (str && str.startsWith(starting) ? str.substring(starting.length) : str);

const isLocalModule = (subModule) => subModule.importPath.startsWith('.') || subModule.importPath.startsWith('/');

const getPackageRoot = (packageImport, rootPath) => {
    const mainFile = resolve.sync(packageImport, { basedir: rootPath });
    const { path: pkgJsonPath } = readPackageUpSync({
        cwd: path.dirname(mainFile),
    });
    return path.dirname(pkgJsonPath);
};

const isDir = (path) => fsSync.statSync(path).isDirectory();

const copyAssets = (list, srcBase, destBase, fromEntity) => {
    if (list) {
        _.each(list, (dest, src) => {
            _.castArray(dest).forEach((_dest) => {
                const destPath = path.resolve(destBase, _dest);
                const alreadyExist = fsSync.existsSync(destPath);
                fsSync.mkdirSync(path.dirname(destPath), { recursive: true });
                fsSync.copyFileSync(path.resolve(srcBase, src), destPath);
                if (alreadyExist && fromEntity) {
                    console.log(`Overrided "${_dest}" from ${fromEntity}`);
                } else {
                    console.log(`Copied "${_dest}"` + (fromEntity ? ` from ${fromEntity}` : ''));
                }
            });
        });
    }
};

const generateRuntimeConfig = (
    i18nNamespaces,
    { app, i18n, sentry, svgIcons, services, tailwind, subModules },
    pkgJson
) => {
    // Saved i18n namespaces and svgicon prefix into runtime config

    const { name, ...otherOpts } = processAppConfig(app);

    let runtimeConfig = {
        app: app.name,
        ...otherOpts,
        i18n: { ...i18n, ns: [...i18n.ns, ...i18nNamespaces] },
        sentry,
        services,
        svgIconPrefix: svgIcons.symbolIdPrefix,
    };

    const tailwindVersion = getPackageMajorVersion(pkgJson, 'tailwindcss');

    if (tailwindVersion === 3) {
        const tailwind3ConfigFile = './src/tailwind-runtime.config.json';

        if (!fsSync.existsSync(tailwind3ConfigFile)) {
            throw new Error('Tailwind runtime file not found!');
        }

        runtimeConfig.tailwind = JSON.parse(fsSync.readFileSync(tailwind3ConfigFile, 'utf-8'));
    } else if (tailwindVersion === 4) {
        const tailwindScanPackagePrefix = ['@xgent/react', '@xgent/grafton', '@xgent/ui-'];

        const packageDeps = Object.keys(pkgJson.dependencies || {});
        const tailwindPkgs = packageDeps.filter((dep) =>
            tailwindScanPackagePrefix.some((prefix) => dep.startsWith(prefix))
        );

        const scanSources = [];

        tailwindPkgs.forEach((pkg) => {
            scanSources.push(`../node_modules/${pkg}/dist/*.es*.js`);
            scanSources.push(`../node_modules/${pkg}/dist/**/*.css`);
        });

        if (tailwind) {
            const { content, colors } = tailwind;
            if (content) {
                scanSources.push(...content);
            }
            if (colors) {
                // todo:
            }
        }

        subModules.forEach((subModule) => {
            if (subModule.mode === 'package') {
                scanSources.push('../node_modules/' + subModule.importPath + '/dist/*.es*.js');
                scanSources.push('../node_modules/' + subModule.importPath + '/dist/**/*.css');
            }
        });

        fsSync.writeFileSync('./src/runtime.css', scanSources.map((line) => `@source "${line}";`).join('\n'), 'utf-8');
        console.log('Generated "./src/runtime.css" for tailwind v4');
    }

    fsSync.writeFileSync('./src/runtime.config.json', JSON.stringify(runtimeConfig, null, 2));
    console.log('Generated "./src/runtime.config.json"');
};

const processSubModules = (subModules, mainRoot = 'src') => {
    const rootPath = path.resolve(mainRoot);

    const sitemap = {};
    const subRouters = {};
    const i18nNamespaces = new Set();
    const i18nToCopy = ['./node_modules/@xgent/grafton/dist'];
    const i18nToExtract = [];

    subModules.forEach((module) => {
        if (module.enabled) {
            const isLocal = isLocalModule(module);

            if (module.mode === 'builtin') {
                if (!isLocal) {
                    throw new Error(
                        `Built-in module path must be a relative path to "${mainRoot}". Module: ${module.importPath}`
                    );
                }
            } else {
                if (isLocal) {
                    throw new Error(`External module path must be a package name. Module: ${module.importPath}`);
                }
            }

            // merge sitemap and extract sub-routers settings
            const moduleRoot = isLocal
                ? path.join(rootPath, module.importPath)
                : getPackageRoot(module.importPath, rootPath);
            const sitemapPath = path.resolve(moduleRoot, 'sitemap.json');

            if (fsSync.existsSync(sitemapPath)) {
                let _sitemap = JSON.parse(fsSync.readFileSync(sitemapPath, 'utf-8'));
                const overrideInfo = _.pick(module, ['module', 'label', 'path', 'url']);
                Object.assign(_sitemap, overrideInfo);

                if (module.defaultRoute) {
                    _sitemap.defaultPage = module.defaultRoute;
                }

                if (sitemap[_sitemap.module]) {
                    throw new Error(`Duplicate module name: ${_sitemap.module}`);
                }

                sitemap[_sitemap.module] = _sitemap;

                if (module.mode === 'app') {
                    if (!_sitemap.url) {
                        throw new Error(`"url" is required for micro-app submodule: ${_sitemap.module}`);
                    }
                } else {
                    if (!_sitemap.path) {
                        throw new Error(`"path" is required for non-independent submodule: ${_sitemap.module}`);
                    }
                }
            }

            if (module.mode !== 'app') {
                if (module.i18n) {
                    if (module.mode === 'package' || module.mode === 'assets') {
                        module.i18n.forEach((ns) => i18nNamespaces.add(ns));
                        i18nToCopy.push(`./node_modules/${module.importPath}`);
                    } else {
                        throw new Error(
                            `"i18n" is only supported by "package" and "assets" mode. Module: ${module.importPath}`
                        );
                    }
                } else if (module.i18nExtracts) {
                    if (module.mode === 'builtin') {
                        Object.keys(module.i18nExtracts).forEach((ns) => i18nNamespaces.add(ns));
                        i18nToExtract.push(_.mapValues(module.i18nExtracts, (value) => path.join(mainRoot, value)));
                    } else {
                        throw new Error(
                            `"i18nExtracts" is only supported for "builtin" mode. Module: ${module.importPath}`
                        );
                    }
                }

                if (module.mode !== 'assets') {
                    subRouters[module.path] = {
                        importPath: module.importPath,
                        defaultRoute: module.defaultRoute,
                        isLazy: module.isLazy,
                    };
                } else if (module.mode !== 'assets') {
                    throw new Error(`"sitemap.json" not found in "${module.mode}" module "${module.importPath}"`);
                }

                // copy assets into main app
                const moduleConfigFile = path.resolve(moduleRoot, 'grafton-module.json');
                if (fsSync.existsSync(moduleConfigFile)) {
                    const { assets } = JSON.parse(fsSync.readFileSync(moduleConfigFile, 'utf-8'));

                    if (assets) {
                        const fromEntity = `module "${module.importPath}"`;
                        copyAssets(assets, moduleRoot, process.cwd(), fromEntity);
                    }
                }
            }
        }
    });

    fsSync.writeFileSync(
        './public/sitemap.json',
        JSON.stringify(
            _.reduce(
                sitemap,
                (result, obj) => {
                    result.push(obj);
                    return result;
                },
                []
            ),
            null,
            2
        )
    );
    console.log('Sitemap generated in "./public/sitemap.json"');

    return {
        subRouters,
        i18nToCopy,
        i18nToExtract,
        i18nNamespaces: Array.from(i18nNamespaces),
    };
};

function getPackageMajorVersion(pkgJson, pkg) {
    // Merge dependencies and devDependencies
    const allDeps = {
        ...(pkgJson.dependencies || {}),
        ...(pkgJson.devDependencies || {}),
    };

    const spec = allDeps[pkg];
    if (!spec) return null;

    // Strip any leading non-digits (e.g. ^, ~, >=) and grab the first number before the dot
    const cleaned = spec.replace(/^[^\d]*/, '');
    const major = parseInt(cleaned.split('.')[0], 10);

    return Number.isNaN(major) ? null : major;
}

export function processGraftonAppConfig() {
    const pkgJson = JSON.parse(fsSync.readFileSync('./package.json', 'utf-8'));

    const isGraftonApp = fsSync.existsSync(graftonAppConfigFile);
    if (isGraftonApp) {
        const hasLocal = fsSync.existsSync(graftonAppLocalConfigFile);
        const graftonConfigPath = hasLocal ? graftonAppLocalConfigFile : graftonAppConfigFile;
        const graftonConfig = JSON.parse(fsSync.readFileSync(graftonConfigPath, 'utf-8'));

        const { subModules, svgIcons, assets } = graftonConfig;

        if (assets) {
            const cwd = process.cwd();
            copyAssets(assets, cwd, cwd);
        }

        const { subRouters, i18nToCopy, i18nToExtract, i18nNamespaces } = processSubModules(subModules);

        generateRuntimeConfig(i18nNamespaces, graftonConfig, pkgJson);

        return {
            subRouters,
            i18nToCopy,
            i18nToExtract,
            svgIcons,
        };
    }

    return {};
}

export function ClosePlugin() {
    return {
        name: 'ClosePlugin', // required, will show up in warnings and errors

        // use this to catch errors when building
        buildEnd(error) {
            if (error) {
                console.error('Error bundling');
                console.error(error);
                process.exit(1);
            } else {
                console.log('Build ended');
            }
        },

        // use this to catch the end of a build without errors
        closeBundle(id) {
            console.log('Bundle closed');
            process.exit(0);
        },
    };
}

/**
 * Vite plugin to generate routes based on the file system structure.
 */
export default function generateRoutesPlugin(options = {}) {
    const {
        root = 'src', // Default to 'src' if not specified
        routesDir = 'pages',
        runtimePagesDir = 'runtime_modules',
        reactRouterLib = 'react-router-dom',
        subRouters,
        enabled = true,
        enableSentry = false,
    } = options;

    const rootPath = path.resolve(root);

    const moduleMap = {};
    let routesPattern = routesDir.startsWith('/') ? routesDir : `/${routesDir}`;
    routesPattern = routesPattern.endsWith('/') ? routesPattern : `${routesPattern}/`;

    // visit all pages
    async function visitPages(dir, handleRouteFile, handleDir) {
        let entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                await handleDir(fullPath);
                await visitPages(fullPath, handleRouteFile, handleDir);
            } else if (entry.isFile() && isRouteFile(entry.name)) {
                await handleRouteFile(fullPath);
            }
        }
    }

    /**
     * Recursively build routes from the directory structure.
     * @param {string} rootDir - The root directory of the routes.
     * @param {string} currentDir - The current directory to process.
     * @param {boolean} isRoot - Whether the current directory is the root.
     * @param {string} parentPath - The parent path of the current directory.
     * @returns {Promise<Array>} The generated routes.
     */
    async function buildRoutes(rootDir, currentDir, isRoot, parentPath = '/') {
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
                const children = await buildRoutes(rootDir, fullPath, isRoot, routePath);
                routes.push({
                    path: routePath,
                    children,
                });
            } else if (entry.isFile() && isRouteFile(entry.name)) {
                const isAnyDeeper = entry.name.startsWith('_any.');
                const isLazy = entry.name.endsWith('.lazy_.jsx');
                const isIndex = entry.name.endsWith('index.jsx') || entry.name.endsWith('index.lazy_.jsx');
                const isLayout = entry.name.startsWith('_layout.');
                const isError = entry.name.startsWith('_error.');

                let componentName = generateComponentName(relativePath);
                if (isError) {
                    componentName += 'Boundary';
                }

                /*
                if (isIndex) {
                    if (entry.name !== 'index.jsx' && entry.name !== 'index.lazy_.jsx') {
                        throw new Error(`Index route does not support flat mode. File: ${fullPath}`);
                    }
                }
                    */

                if (isLayout && isLazy) {
                    throw new Error(
                        `Layout route does not support lazy, you can use a lazy sub-module instead. File: ${fullPath}`
                    );
                }

                let importPath = `./${path.join(routesDir, relativePath).replace(/\\/g, '/')}`;
                if (importPath.endsWith('.jsx')) {
                    importPath = importPath.slice(0, -4);
                } else if (importPath.endsWith('.js')) {
                    importPath = importPath.slice(0, -3);
                }

                const slashPos = routePath.lastIndexOf('/');
                const isFlatIndex = slashPos > 0 && !entry.name.startsWith('index.');

                let route = {
                    path: isAnyDeeper
                        ? routePath + (routePath.endsWith('/') ? '*' : '/*')
                        : isIndex
                        ? isFlatIndex
                            ? routePath.substring(0, slashPos)
                            : parentPath
                        : routePath,
                    element: componentName,
                    importPath,
                    isLazy,
                    isLayout,
                    isError,
                    isIndex,
                    isAnyDeeper,
                };

                if (isIndex && isFlatIndex) {
                    route = {
                        path: routePath.substring(0, slashPos),
                        children: [route],
                    };
                }

                routes.push(route);
            }
        }

        return routes;
    }

    /**
     * Build routes from the directory and generate the routes file.
     * @param {*} sourcePath
     * @param {*} isRoot
     */
    async function buildRoutesFromDirectory(sourcePath, isRoot) {
        const routesPath = path.resolve(sourcePath, routesDir);
        moduleMap[routesPath] = { sourcePath, isRoot };

        const relOutputFile = isRoot
            ? path.join(sourcePath, 'router.runtime.jsx')
            : path.join(sourcePath, 'sub-routes.runtime.jsx');

        const outputFile = path.resolve(relOutputFile);

        const routes = await buildRoutes(routesPath, routesPath, isRoot, '/');

        const fileContent = generateRoutesFileContent(
            routes,
            isRoot ? subRouters : undefined,
            isRoot,
            enableSentry
        ).replace(/\\/g, '/');

        await fs.writeFile(outputFile, fileContent, 'utf-8');
        console.log(`Generated ${relOutputFile}`);
    }

    /**
     * Generate the content of the routes.runtime.jsx file.
     */
    function generateRoutesFileContent(routes, subRoutes, isRoot, enableSentry) {
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

                const { path, element, importPath, isLazy, isLayout, isError, isIndex, children } = route;

                // 处理路径或索引
                routeDef.path = path;

                let [parentPath] = splitLast(routeDef.path, '/');
                if (!parentPath) {
                    parentPath = '/';
                }

                // 处理元素
                if (importPath && element) {
                    const componentName = element;

                    if (isError) {
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
                            routeMergeMap[parentPath].children = [
                                ...(routeMergeMap[parentPath].children || []),
                                routeDef,
                            ];
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
                        ? routeInfo.importPath + '/sub-routes.runtime'
                        : runtimePagesDir + '/' + _.kebabCase(_path) + '/sub-routes.runtime');

                let routeDef = {
                    path: _path,
                };

                if (routeInfo.isLazy) {
                    if (!routeInfo.defaultRoute || routeInfo.defaultRoute === '/') {
                        throw new Error(
                            `Default route is required for lazy sub-routes: "${_path}" and it should not be "/".`
                        );
                    }

                    lazyImports += `const lazy${componentName} = () => import('${importPath}');\n`;
                    const redirectPath = path.join(_path, routeInfo.defaultRoute).replace(/\\/g, '/');
                    routeDef.children = `[{ index: true, element: <Navigate to='${redirectPath}' /> }]`;
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
            let createRouter;

            if (enableSentry) {
                importStatements += `import { createBrowserRouter,
    createRoutesFromChildren,
    matchRoutes,
    useLocation,
    useNavigationType, 
    Navigate,
} from '${reactRouterLib}';
import { Runtime } from '@xgent/grafton';
import * as Sentry from '@sentry/react';\n`;

                createRouter = `let _createBrowserRouter;

const sentryConfig = Runtime.config.sentry;
if (!Runtime.isDevMode && sentryConfig && sentryConfig.dsn) {
    Sentry.init({
        integrations: [
            Sentry.browserTracingIntegration(), 
            Sentry.replayIntegration(),
            Sentry.reactRouterV7BrowserTracingIntegration({
                useEffect: React.useEffect,
                useLocation,
                useNavigationType,
                createRoutesFromChildren,
                matchRoutes,
            }),
        ],
        tracesSampleRate: 1.0, 
        replaysSessionSampleRate: 0.1, 
        replaysOnErrorSampleRate: 1.0, 
        ...sentryConfig,
    });

    Runtime.sentry = Sentry;

    _createBrowserRouter = Sentry.wrapCreateBrowserRouterV7(
        createBrowserRouter,
    );
} else {
    _createBrowserRouter = createBrowserRouter;
}

const router = _createBrowserRouter(routes, { patchRoutesOnNavigation: lazyRouting });\n`;
            } else {
                importStatements += `import { createBrowserRouter, Navigate } from '${reactRouterLib}';\n`;
                createRouter = `const router = createBrowserRouter(routes, { patchRoutesOnNavigation: lazyRouting });\n`;
            }

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

${createRouter}
export default router;
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

    async function copyPages(routesPath, runtimePagesPath, key) {
        await fs.rm(runtimePagesPath, { recursive: true, force: true });
        await fs.mkdir(runtimePagesPath, { recursive: true });

        async function handleRouteFile(fullPath) {
            await copyPageFile(routesPath, runtimePagesPath, fullPath, key);
        }

        async function handleDir(fullPath) {
            const relativePath = path.relative(routesPath, fullPath);
            const newDir = path.resolve(runtimePagesPath, relativePath);
            await fs.mkdir(newDir, { recursive: true });
        }

        await visitPages(routesPath, handleRouteFile, handleDir);
        const cwd = process.cwd();
        console.log(
            `Sub-module pages copied ${path.relative(cwd, routesPath)} -> ${path.relative(cwd, runtimePagesPath)}`
        );
    }

    async function copyPageFile(srcRootPath, destRootPath, fullPath, key, singleFile) {
        const relativePath = path.relative(srcRootPath, fullPath);
        const newFile = path.resolve(destRootPath, relativePath);

        if (singleFile) {
            if (!fsSync.existsSync(fullPath)) {
                await fs.unlink(newFile);
                console.log(`Removed page ${newFile}`);
                return;
            }
        }
        const content = await fs.readFile(fullPath, 'utf-8');
        const newContent = content.replace(
            /import\s+(\{\s*.+\s*\})\s+from\s+['"]@package@([^'"]*)['"]/g,
            (match, component, importPath) => {
                return `import ${component} from '${subRouters[key].importPath}${importPath}'`;
            }
        );

        await fs.writeFile(newFile, newContent, 'utf-8');
        if (singleFile) {
            console.log(`Updated page ${newFile}`);
        }
    }

    let preBuildDone = false;

    async function preBuild(isDevServer) {
        for (let key in subRouters) {
            const routeInfo = subRouters[key];

            if (!isLocalModule(routeInfo)) {
                const packageRoot = getPackageRoot(routeInfo.importPath, rootPath);
                const importPath = routeInfo.root ? path.join(packageRoot, routeInfo.root) : packageRoot; // ;
                const srcRoutesPath = path.resolve(importPath, routesDir);

                const newImportPath = './' + path.join(runtimePagesDir, _.kebabCase(key));
                const runtimePagesPath = path.resolve(rootPath, newImportPath, routesDir);

                await copyPages(srcRoutesPath, runtimePagesPath, key);

                if (isDevServer) {
                    (async () => {
                        const watcher = fs.watch(srcRoutesPath, { recursive: true });
                        for await (const event of watcher) {
                            const fullPath = path.resolve(srcRoutesPath, event.filename);
                            if (!isDir(fullPath)) {
                                //console.log(`[detected change] ${event.eventType}: ${fullPath}`);
                                await copyPageFile(srcRoutesPath, runtimePagesPath, fullPath, key, true);
                            }
                        }
                    })();
                }
            }
        }

        preBuildDone = true;
        console.log('Pre-build done');
    }

    return {
        name: 'vite-plugin-file-based-react-router',

        async configureServer() {
            if (!enabled) {
                return;
            }

            await preBuild(true);
        },

        async buildStart() {
            if (!enabled) {
                return;
            }

            if (!preBuildDone) {
                await preBuild(false);
            }

            await buildRoutesFromDirectory(root, true);

            for (let key in subRouters) {
                const routeInfo = subRouters[key];

                let sourcePath;

                if (isLocalModule(routeInfo)) {
                    sourcePath = path.join(root, routeInfo.importPath);
                } else {
                    sourcePath = path.join(root, runtimePagesDir, _.kebabCase(key));
                }

                await buildRoutesFromDirectory(sourcePath, false);
            }
        },

        async watchChange(id) {
            const pos = id.indexOf(routesPattern);
            if (pos !== -1) {
                const modulePath = id.substring(0, pos + routesPattern.length - 1);
                const mdouleInfo = moduleMap[modulePath];
                if (mdouleInfo != null) {
                    //console.log(`[watch change] ${id}`);
                    await buildRoutesFromDirectory(mdouleInfo.sourcePath, mdouleInfo.isRoot);
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
 * Check if a file should be treated as a route file.
 */
function isRouteFile(name) {
    return name.endsWith('.jsx');
}

/**
 * Generate a unique component name based on the file path.
 */
function generateComponentName(relativePath) {
    let componentName = relativePath
        .replace(/[\/\\]/g, '_')
        .replace(/\.lazy_\.jsx$/, '')
        .replace(/\.jsx$/, '')
        .replace(/\.js$/, '')
        //.replace(/_any$/, '')
        .replace(/\[(.+?)\]/g, '$1')
        .replace(/[^a-zA-Z0-9_]/g, '');

    componentName = _.camelCase(componentName);

    return _.upperFirst(componentName);
}

const KEY_ORDERS = ['index', 'path', 'element', 'errorElement', 'handle', 'lazy'];

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
                        orderedRoute[key] = trimStart(trimStart(orderedRoute[key], parentPath), '/');
                    }
                }
            }

            if (route.children && route.children.length > 0) {
                // for path only routes, move children to parent
                if (Object.keys(orderedRoute).length === 1 && 'path' in orderedRoute) {
                    const [onlyChild] = tidyRoutes(route.children, isRoot, parentPath);
                    if (onlyChild.index && orderedRoute.path.indexOf('/') > 0) {
                        delete onlyChild.index;
                        onlyChild.path = orderedRoute.path;
                        return onlyChild;
                    } 

                    if (onlyChild.index) {
                        orderedRoute.children = [onlyChild];
                        return orderedRoute;
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
