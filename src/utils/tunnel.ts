import { createReadStream } from 'fs'
import { StatusCodes } from 'http-status-codes'
import _ from 'lodash'
import { lookup } from 'mime-types'
import { join } from 'path/posix'
import { unescape } from 'querystring'
import { pathToFileURL } from 'url'
import { defaultPaths, globPatterns } from './constants'
import {
  encapsulateModule,
  getFolderPath,
  globFind,
  globFindAll,
  normalizePath,
} from './path'
import { sendResponseParser } from './response'

export async function tunnel(
  { data, config, basePath }: Omit<WorkerProps, 'requestId'>,
  endCallback: (state: ResponseState, data: ResponseData) => void,
) {
  const context = {
    ...data,
    params: {},
    query: new URLSearchParams(data.query || ''),
  } as IntREST.IntRequest

  // Send response if static file found
  const staticFolder = await getFolderPath(basePath, globPatterns.staticFolder)
  if (staticFolder) {
    const staticFile = await globFind(staticFolder, context.path)
    if (staticFile) {
      const mimeType = lookup(staticFile)
      if (mimeType) {
        return await sendResponse(
          {
            status: StatusCodes.OK,
            body: createReadStream(staticFile),
            headers: {
              'Content-Type': mimeType,
            },
          },
          context.headers,
          endCallback,
        )
      }
    }
  }

  try {
    const identities = await getIdentities(context.path)

    // Send response not found if no route found
    if (!identities.length) {
      return await sendResponse(
        {
          status: StatusCodes.NOT_FOUND,
          body: {
            message: config.messages?.NOT_FOUND || 'Not found',
          },
          headers: {
            'Content-Type': 'application/json',
          },
        },
        context.headers,
        endCallback,
      )
    }

    const method = context.method
    const basePathCompiled = join(
      defaultPaths.compiledFolder,
      defaultPaths.compiledRoutes,
    )
    const routes = await Promise.all(
      identities.map(async (i) => {
        const routeModule = await import(
          encapsulateModule(
            pathToFileURL(
              join(basePathCompiled, i.pathname, 'route.mjs'),
            ).toString(),
          )
        )
        return {
          handler: (routeModule[method] ||
            routeModule['ALL'] ||
            routeModule.default) as IntREST.RequestHandler | undefined,
          identity: i,
        }
      }),
    )
    const route = routes.find((r) => typeof r.handler === 'function')

    // Send response not allowed if method not found in route
    if (!route?.handler) {
      return await sendResponse(
        {
          status: StatusCodes.METHOD_NOT_ALLOWED,
          body: {
            message:
              config.messages?.METHOD_NOT_ALLOWED || 'Method not allowed',
          },
          headers: {
            'Content-Type': 'application/json',
          },
        },
        context.headers,
        endCallback,
      )
    }

    const paramExtract = route.identity.paramExtract
    const pathname = route.identity.pathname
    const paramKeys = route.identity.paramKeys
    const paramValues = Array.from(data.path.match(paramExtract) || []).slice(1)
    context.params = _.zipObject(paramKeys, paramValues.map(unescape))

    const middlewares = await getMiddlewares(pathname)

    const response = await callRecursiveMiddlewares({
      middlewares,
      context,
      config,
      requestHandler: route.handler,
    })

    if (response) {
      return await sendResponse(response, context.headers, endCallback)
    }

    return await sendResponse(
      {
        status: StatusCodes.NO_CONTENT,
      },
      context.headers,
      endCallback,
    )
  } catch (error) {
    console.error(error)
    if (error instanceof Error) {
      return await sendResponse(
        {
          status: StatusCodes.INTERNAL_SERVER_ERROR,
          body: {
            message: error.message,
          },
          headers: {
            'Content-Type': 'application/json',
          },
        },
        context.headers,
        endCallback,
      )
    } else if (typeof error === 'object' && error != null) {
      return await sendResponse(error, context.headers, endCallback)
    }

    throw error
  }
}

async function sendResponse(
  resData: IntREST.IntResponse,
  reqHeaders: IntREST.IntRequest['headers'],
  endCallback: (state: ResponseState, data: ResponseData) => void,
) {
  return await sendResponseParser(resData, reqHeaders, 'void', (ev) => {
    const { state, data } = ev
    endCallback(state, data)
  })
}

async function getIdentities(route: string) {
  const basePath = join(
    process.cwd(),
    defaultPaths.compiledFolder,
    defaultPaths.compiledRoutes,
  )
  const identitiesPaths = await globFindAll(
    basePath,
    globPatterns.identityPoints,
  )
  const identitiesModules = await Promise.all(
    identitiesPaths.map((p) =>
      import(encapsulateModule(pathToFileURL(p).toString())).then(
        (m) => m as AutoGeneratedVars,
      ),
    ),
  )
  return identitiesModules
    .filter((m) => m.paramExtract.test(route))
    .sort(sortCompiledRoutes)
}

async function getMiddlewares(pathname: string) {
  const basePath = join(
    process.cwd(),
    defaultPaths.compiledFolder,
    defaultPaths.compiledRoutes,
  )
  const pathnames = pathname
    .split('/')
    .map((_, i, l) => (i > 0 ? l.slice(0, i + 1).join('/') : '/'))
    .map((p) => normalizePath(join(basePath, p, 'middleware.mjs')))
  const middlewarePaths = await globFindAll(
    basePath,
    globPatterns.middlewarePoints,
  )
  const validMiddlewarePaths = middlewarePaths.filter((p) =>
    pathnames.some((pn) => p === pn),
  )

  const middlewareModules = await Promise.all(
    validMiddlewarePaths.map(async (p) => ({
      handler: await import(
        encapsulateModule(pathToFileURL(p).toString())
      ).then((m) => (m.middleware || m.default) as IntREST.MiddlewareHandler),
      pathname: p.replace(basePath, ''),
    })),
  )
  return middlewareModules.filter((m) => typeof m.handler === 'function')
}

function sortCompiledRoutes(a: AutoGeneratedVars, b: AutoGeneratedVars) {
  const aSlipt = a.pathname.split('/')
  const bSlipt = b.pathname.split('/')
  for (let i = 0; i < aSlipt.length; i++) {
    if (aSlipt[i][0] === '[' && bSlipt[i]?.[0] === '[') continue
    if (aSlipt[i][0] === '[') return 1
    if (bSlipt[i]?.[0] === '[') return -1
  }
  if (b.route.toLowerCase() > a.route.toLowerCase()) return -1
  if (b.route.toLowerCase() < a.route.toLowerCase()) return 1
  return b.pathname.length - a.pathname.length
}

interface MiddlewareModule {
  handler: IntREST.MiddlewareHandler
  pathname: string
}

interface CallRecursiveMiddlewaresArgs {
  middlewares: MiddlewareModule[]
  context: IntREST.IntRequest
  config: IntREST.Config
  requestHandler: IntREST.RequestHandler
}

async function callRecursiveMiddlewares({
  middlewares,
  context,
  config,
  requestHandler,
}: CallRecursiveMiddlewaresArgs): Promise<void | IntREST.IntResponse> {
  if (!middlewares.length) return requestHandler(context)
  const middleware = middlewares[0]

  const timeoutId = setTimeout(() => {
    throw new Error(`Middleware handler timeout: ${middleware.pathname}`)
  }, config.limits?.middleware?.timeout || 5000)

  return middleware.handler(context, (c?: CustomRequestData) => {
    clearTimeout(timeoutId)
    context.custom = _.merge(context.custom, c)
    return callRecursiveMiddlewares({
      middlewares: middlewares.slice(1),
      context,
      config,
      requestHandler,
    })
  })
}
