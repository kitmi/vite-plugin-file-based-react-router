# vite-plugin-file-based-react-router

Opinionated vite plugin to generate file-based routes for using with react-router.

Inspired from `tanstack.com/router`, but without **TypeScript**.

## Features

- [x] supports **lazy** import
- [x] supports react-router loader [Refers to react-router Data-loading feature](https://reactrouter.com/en/main/start/overview#data-loading), useful to prepare page data or redirect according to acl check
- [x] supports `.../*` sub-routers [Refers to react-router FAQ](https://reactrouter.com/en/main/start/faq#how-do-i-nest-routes-deep-in-the-tree)
- [x] supports page metadata as **route handle**  [Refers to react-router usage](https://reactrouter.com/en/main/hooks/use-matches#breadcrumbs)

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
├── _error.jsx : component as errorElement under /
├── _layout.jsx : layout as element under /
├── app 
│   ├── [module]
│   │   └── _any.lazy_.jsx : component as element under /app/:module/* with lazy import
│   └── _layout.jsx : layout as element under /app
├── route1 
│   └── index.jsx : component as element under /route1
├── index.loader_.jsx : (async) function as loader under /
├── login.lazy_.jsx : component as element under /login
└── logout.loader_.jsx : (async) function as loader under /logout
```

- Sample files under `src/modules/editor/pages` as sub-router:

```
├── _layout.jsx : layout as element under /app/editor
├── project.[id].edit.lazy_.jsx : component as element under /app/editor/project/:id/edit with lazy import
├── project.lazy_.jsx : component as element under /app/editor/project with lazy import
└── workspace.jsx : component as element under /app/editor/workspace 
```

## Route component (as element or errorElement)

```js
export const metadata = {
  //...
}; // exposed as handle

export default Component; // as layout, page or error
```

## Data loader

```js
export default ({ params }) => { 
    const result = do_some_thing_before_rendering_page();
    return result; // can be accessed by useLoaderData() in the page component
}
```

After running `vite dev` or `vite build`, it will generate
- ./src/routes.runtime.jsx
- ./src/modules/editor/sub-routes.runtime.jsx 

## Usage

```js
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import routes from "./routes.runtime";

const router = createBrowserRouter(routes);

<RouterProvider router={router} />
```

## License

MIT