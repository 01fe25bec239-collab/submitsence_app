import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";

type Req = { requestId?: string };
type Res = { status(code: number): { json(body: unknown): void } };

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Req>();
    const res = ctx.getResponse<Res>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const response = exception instanceof HttpException ? exception.getResponse() : {};
    const safeMessage =
      typeof response === "object" && response && "message" in response
        ? Array.isArray((response as { message: unknown }).message)
          ? "Request validation failed"
          : String((response as { message: unknown }).message)
        : status >= 500
          ? "Unexpected server error"
          : "Request failed";
    const diagnosticCode = exception && typeof exception === "object" && "code" in exception ? String((exception as { code: unknown }).code) : `HTTP_${status}`;
    res.status(status).json({ requestId: req.requestId, error: { message: safeMessage, diagnosticCode } });
  }
}
