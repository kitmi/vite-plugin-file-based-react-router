# vite-plugin-file-based-react-router

Opinionated vite plugin to generate file-based routes for using with react-router.

Inspired from `tanstack.com/router`, but without **TypeScript**.

## Features

- [x] supports React's **lazy** import and React Router's **lazy route modules**
    
    [Refers to React Router's lazy feature](https://reactrouter.com/en/main/route/lazy)

- [x] supports react-router loader

    [Refers to React Router's data-loading feature](https://reactrouter.com/en/main/start/overview#data-loading), useful to prepare page data or redirect before rendering component

- [x] supports `.../*` sub-routers

    [Refers to React Router's FAQ](https://reactrouter.com/en/main/start/faq#how-do-i-nest-routes-deep-in-the-tree)

- [x] supports page metadata as **route handle** 

    [Refers to React Router's handle usage](https://reactrouter.com/en/main/hooks/use-matches#breadcrumbs)

- [x] supports routing to a sub module as a npm package

## To-do

- [ ] unit tests
- [ ] duplicate routes detection

## Installation

```bash
npm --save-dev vite-plugin-file-based-react-router
```

## Config

Plugin config in `vite.config.js`.

```js
import fileBasedReactRouter from 'vite-plugin-file-based-react-router';

//...

export default defineConfig({
  plugins: [
    fileBasedReactRouter({
      root, // default as 'src'
      routesDir, // default as 'pages'
      subRouters: { // optional sub-routers
        '/app/editor': { 
          // load sub-router from ./modules/editor and mount it to /app/editor/*
          importPath: './modules/editor',
          isLazy: true,
        },
      },
    }),
    //...
  ]
});
```

## File-based convention

- Sample files under `src/pages`:

```
├── _error.jsx or _error.lazy_.jsx : component as errorElement under /
├── _layout.jsx : layout as element under /
├── app 
│   ├── [module]
│   │   └── _any.lazy_.jsx : component as element under /app/:module/* with lazy import
│   └── _layout.jsx : layout as element under /app
├── route1 
│   └── index.jsx : component as element under /route1
├── index.loader_.js : (async) function as loader under /
├── login.lazy_.jsx : component as element under /login
└── logout.loader_.js : (async) function as loader under /logout
```

- Sample files under `src/modules/editor/pages` as sub-router:

```
├── _layout.jsx : layout as element under /app/editor
├── project.[id].edit.lazy_.jsx : component as element under /app/editor/project/:id/edit with lazy import
├── project.lazy_.jsx : component as element under /app/editor/project with lazy import
└── workspace.jsx : component as element under /app/editor/workspace 
```

## Route component (as element)

```js
export const handle = {
  //...
}; // exposed as handle

export const Component = () => {...}; // as layout or page 
Component.displayName = 'ComponentName'; // optional, useful for inspection
```

## Data loader

```js
export default ({ params }) => { 
    const result = do_some_thing_before_rendering_page();
    return result; // can be accessed by useLoaderData() in the page component
}
```

## Error component (as errorElement)

```js
function ErrorComponent() {
    const error = useRouteError();
    // ...
};

export default ErrorComponent;
```

## Lazy module

```js
// loader is optional
export const loader = ({ params }) => { 
    const result = do_some_thing_before_rendering_page();
    return result; // can be accessed by useLoaderData() in the page component
}

export const handle = {
  //...
}; 

export const Component = () => {...}; // as page 
Component.displayName = 'ComponentName'; // optional, useful for inspection
```

## Runtime generated files

After running `vite dev` or `vite build`, it will generate
- ./src/routes.runtime.jsx
- ./src/modules/editor/sub-routes.runtime.jsx 

## Usage

```js
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import routes, { lazyRouting } from './routes.runtime';

const router = createBrowserRouter(routes, { patchRoutesOnNavigation: lazyRouting });

<RouterProvider router={router} />
```

## License

MIT