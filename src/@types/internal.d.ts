type OmittedRequest =
  | 'query'
  | 'params'
  | 'assetsStream'
  | 'assetsRawContent'
  | 'assetsContent'

/**
 * The props that are passed from app worker to the router worker.
 */
declare interface WorkerProps {
  /**
   * This is used to identify the request, because the router worker can
   * handle multiple requests at the same time.
   */
  requestId: string
  /**
   * The project root path.
   */
  basePath: string
  /**
   * The project configuration object.
   */
  config: IntREST.Config
  /**
   * The request object.
   */
  data: Omit<IntREST.IntRequest, OmittedRequest> & {
    query: string
  }
}

/**
 * The props that are passed from router worker to the app worker.
 */
declare type ResponseState =
  | 'cookie'
  | 'clear-cookie'
  | 'set'
  | 'write'
  | 'status'
  | 'end'

/**
 * The props that are passed from router worker to the app worker.
 */
declare type ResponseDataMap = {
  cookie: {
    name: string
    value: string
    options?: IntREST.CookieOptions
  }
  'clear-cookie': {
    name: string
    options?: IntREST.CookieOptions
  }
  set: [string, number | string | readonly string[] | undefined]
  status: number
  write: Uint8Array
  read?: number
  end?: undefined
}

/**
 * The props that are passed from router worker to the app worker.
 */
declare type ResponseData = ResponseDataMap[ResponseState]

/**
 * The props that are passed from router worker to the app worker.
 */
declare interface TransferResponse {
  requestId: string
  state: ResponseState
  data: ResponseData
}
