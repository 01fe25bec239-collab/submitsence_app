import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { CognitoAuthGuard, PermissionGuard, RequirePermission, TenantGuard } from "../auth/auth.guards";
import type { AuthedRequest } from "../auth/auth.types";
import { ApiService } from "./api.service";
import * as api from "./validation";

@UseGuards(CognitoAuthGuard, TenantGuard, PermissionGuard)
@Controller("tenants/:tenantId")
export class ApiController {
  constructor(private readonly service: ApiService) {}

  @Get("projects/search")
  searchProjects(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.listProjects(req.auth!, query);
  }

  @Get("projects")
  listProjects(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.listProjects(req.auth!, query);
  }

  @Post("projects")
  createProject(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.createProject(req.auth!, api.object(body), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId")
  getProject(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.getProject(req.auth!, projectId);
  }

  @RequirePermission("project_manage", "projectId")
  @Patch("projects/:projectId")
  updateProject(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.updateProject(req.auth!, projectId, api.object(body), req);
  }

  @RequirePermission("archive", "projectId")
  @Post("projects/:projectId/archive")
  archiveProject(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.archiveProject(req.auth!, projectId, true, req);
  }

  @RequirePermission("archive", "projectId")
  @Post("projects/:projectId/unarchive")
  unarchiveProject(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.archiveProject(req.auth!, projectId, false, req);
  }

  @RequirePermission("upload", "projectId")
  @Post("projects/:projectId/documents/uploads")
  initiateUpload(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.initiateUpload(req.auth!, projectId, api.object(body), req);
  }

  @RequirePermission("upload", "projectId")
  @Post("projects/:projectId/documents/finalize")
  finalizeUpload(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.finalizeUpload(req.auth!, projectId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/processing-jobs/:jobId")
  jobStatus(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.service.jobStatus(req.auth!, projectId, jobId);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/spec/worksections")
  worksections(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.listWorksections(req.auth!, projectId);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/spec/worksections/:worksectionId/clauses")
  clauses(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("worksectionId") worksectionId: string) {
    return this.service.listClauses(req.auth!, projectId, worksectionId);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/spec/requirements")
  requirements(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, unknown>) {
    return this.service.listRequirements(req.auth!, projectId, query);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/register-items")
  register(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, unknown>) {
    return this.service.listRegister(req.auth!, projectId, query);
  }

  @RequirePermission("edit", "projectId")
  @Patch("projects/:projectId/register-items/:itemId/assignment")
  assignRegister(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.service.assignRegisterItem(req.auth!, projectId, itemId, api.object(body), req);
  }

  @RequirePermission("edit", "projectId")
  @Patch("projects/:projectId/register-items/:itemId/deadline")
  updateDeadline(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.service.updateRegisterDeadline(req.auth!, projectId, itemId, api.object(body), req);
  }

  @RequirePermission("edit", "projectId")
  @Patch("projects/:projectId/register-items/:itemId/status")
  transitionStatus(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.service.transitionRegisterStatus(req.auth!, projectId, itemId, api.object(body));
  }

  @RequirePermission("sign_off", "projectId")
  @Post("projects/:projectId/register-items/sign-off")
  signOff(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.humanSignOff(req.auth!, projectId, api.object(body));
  }

  @RequirePermission("export", "projectId")
  @Post("projects/:projectId/register-items/export")
  @HttpCode(202)
  exportRegister(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.requestRegisterExport(req.auth!, projectId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/physical-deliverables")
  physicalDeliverables(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.listPhysicalDeliverables(req.auth!, projectId);
  }

  @RequirePermission("edit", "projectId")
  @Post("projects/:projectId/register-items/:itemId/physical-deliverables")
  createPhysical(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.service.createPhysicalDeliverable(req.auth!, projectId, itemId, api.object(body), req);
  }

  @RequirePermission("edit", "projectId")
  @Patch("projects/:projectId/physical-deliverables/:deliverableId")
  updatePhysical(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("deliverableId") deliverableId: string, @Body() body: unknown) {
    return this.service.updatePhysicalDeliverable(req.auth!, projectId, deliverableId, api.object(body), req);
  }

  @RequirePermission("upload", "projectId")
  @Post("projects/:projectId/vendor-catalogues/uploads")
  initiateCatalogueUpload(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.initiateUpload(req.auth!, projectId, api.object(body), req, "vendor_catalogue");
  }

  @RequirePermission("upload", "projectId")
  @Post("projects/:projectId/vendor-catalogues")
  createCatalogue(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.createVendorCatalogue(req.auth!, projectId, api.object(body), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/vendor-catalogues/:catalogueId/parse-status")
  catalogueStatus(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("catalogueId") catalogueId: string) {
    return this.service.vendorCatalogueParseStatus(req.auth!, projectId, catalogueId);
  }

  @Get("vendors")
  vendors(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.listVendors(req.auth!, query);
  }

  @Post("vendors")
  createVendor(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.createVendor(req.auth!, api.object(body), req);
  }

  @Get("products")
  products(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.listProducts(req.auth!, query);
  }

  @Post("products")
  createProduct(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.createProduct(req.auth!, api.object(body), req);
  }

  @Get("products/:productId")
  product(@Req() req: AuthedRequest, @Param("productId") productId: string) {
    return this.service.productDetail(req.auth!, productId);
  }

  @Patch("products/:productId")
  updateProduct(@Req() req: AuthedRequest, @Param("productId") productId: string, @Body() body: unknown) {
    return this.service.updateProduct(req.auth!, productId, api.object(body), req);
  }

  @Get("products/:productId/documents")
  productDocuments(@Req() req: AuthedRequest, @Param("productId") productId: string) {
    return this.service.productDocuments(req.auth!, productId);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/product-matches")
  matches(@Req() req: AuthedRequest, @Param("projectId") projectId: string) {
    return this.service.listProductMatches(req.auth!, projectId);
  }

  @RequirePermission("edit", "projectId")
  @Post("projects/:projectId/product-matches/:matchId/accept")
  acceptMatch(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("matchId") matchId: string) {
    return this.service.decideProductMatch(req.auth!, projectId, matchId, "accepted", req);
  }

  @RequirePermission("edit", "projectId")
  @Post("projects/:projectId/product-matches/:matchId/reject")
  rejectMatch(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("matchId") matchId: string) {
    return this.service.decideProductMatch(req.auth!, projectId, matchId, "rejected", req);
  }

  @RequirePermission("edit", "projectId")
  @Post("projects/:projectId/product-matches/override")
  overrideMatch(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.overrideProductMatch(req.auth!, projectId, api.object(body), req);
  }

  @RequirePermission("edit", "projectId")
  @Post("projects/:projectId/register-items/:itemId/product-matches/rematch")
  rematch(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.service.requestRematch(req.auth!, projectId, itemId, api.idempotencyKey(req.headers, api.object(body)), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/generate")
  @HttpCode(202)
  generateRisks(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.generateRiskFlags(req.auth!, projectId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/risk-flags/jobs/:jobId")
  riskJob(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("jobId") jobId: string) {
    return this.service.jobStatus(req.auth!, projectId, jobId);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/risk-flags")
  risks(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, unknown>) {
    return this.service.listRiskFlags(req.auth!, projectId, query);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/:flagId/confirm")
  confirmRisk(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("flagId") flagId: string, @Body() body: unknown) {
    return this.service.reviewRiskFlag(req.auth!, projectId, flagId, "confirmed", api.object(body), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/:flagId/dismiss")
  dismissRisk(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("flagId") flagId: string, @Body() body: unknown) {
    return this.service.reviewRiskFlag(req.auth!, projectId, flagId, "dismissed", api.object(body), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/:flagId/comment")
  commentRisk(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("flagId") flagId: string, @Body() body: unknown) {
    return this.service.commentRiskFlag(req.auth!, projectId, flagId, api.object(body), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/:flagId/task")
  riskTask(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("flagId") flagId: string, @Body() body: unknown) {
    return this.service.createRiskTask(req.auth!, projectId, flagId, api.object(body), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/risk-flags/:flagId/rfi")
  @HttpCode(202)
  riskRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("flagId") flagId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.createRiskRfi(req.auth!, projectId, flagId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("rfi_manage", "projectId")
  @Post("projects/:projectId/rfis/generate")
  @HttpCode(202)
  generateRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.generateRfi(req.auth!, projectId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/rfis/:rfiId")
  getRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("rfiId") rfiId: string) {
    return this.service.getRfi(req.auth!, projectId, rfiId);
  }

  @RequirePermission("rfi_manage", "projectId")
  @Patch("projects/:projectId/rfis/:rfiId")
  updateRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("rfiId") rfiId: string, @Body() body: unknown) {
    return this.service.updateRfi(req.auth!, projectId, rfiId, api.object(body), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/rfis/:rfiId/mark-reviewed")
  reviewRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("rfiId") rfiId: string) {
    return this.service.markRfiReviewed(req.auth!, projectId, rfiId, req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/rfis/:rfiId/export")
  exportRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("rfiId") rfiId: string, @Body() body: unknown) {
    return this.service.exportRfi(req.auth!, projectId, rfiId, api.idempotencyKey(req.headers, api.object(body)), req);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/rfis/:rfiId/handoff")
  handoffRfi(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("rfiId") rfiId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.handoffRfi(req.auth!, projectId, rfiId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("generate", "projectId")
  @Post("projects/:projectId/packages")
  createPackage(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.createPackage(req.auth!, projectId, input, api.idempotencyKey(req.headers, input), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/packages/:packageId/preview")
  previewPackage(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string) {
    return this.service.packagePreview(req.auth!, projectId, packageId);
  }

  @RequirePermission("generate", "projectId")
  @Post("projects/:projectId/packages/:packageId/items")
  addPackageItem(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Body() body: unknown) {
    return this.service.addPackageItem(req.auth!, projectId, packageId, api.object(body), req);
  }

  @RequirePermission("generate", "projectId")
  @Patch("projects/:projectId/packages/:packageId/items/:packageItemId")
  updatePackageItem(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Param("packageItemId") packageItemId: string, @Body() body: unknown) {
    return this.service.updatePackageItem(req.auth!, projectId, packageId, packageItemId, api.object(body), req);
  }

  @RequirePermission("generate", "projectId")
  @Post("projects/:projectId/packages/:packageId/items/:packageItemId/remove")
  @HttpCode(200)
  removePackageItem(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Param("packageItemId") packageItemId: string) {
    return this.service.removePackageItem(req.auth!, projectId, packageId, packageItemId, req);
  }

  @RequirePermission("generate", "projectId")
  @Post("projects/:projectId/packages/:packageId/items/:packageItemId/documents")
  attachPackageDocument(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Param("packageItemId") packageItemId: string, @Body() body: unknown) {
    return this.service.attachPackageDocument(req.auth!, projectId, packageId, packageItemId, api.object(body), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/packages/:packageId/versions")
  packageVersions(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string) {
    return this.service.packageVersions(req.auth!, projectId, packageId);
  }

  @RequirePermission("generate", "projectId")
  @Post("projects/:projectId/packages/:packageId/regenerate")
  @HttpCode(202)
  regeneratePackage(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Body() body: unknown) {
    return this.service.regeneratePackage(req.auth!, projectId, packageId, api.idempotencyKey(req.headers, api.object(body)), req);
  }

  @RequirePermission("export", "projectId")
  @Post("projects/:projectId/packages/:packageId/export-pdf")
  @HttpCode(202)
  exportPdf(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Body() body: unknown) {
    return this.service.exportPackage(req.auth!, projectId, packageId, "consultant_pdf", api.idempotencyKey(req.headers, api.object(body)), req);
  }

  @RequirePermission("export", "projectId")
  @Post("projects/:projectId/packages/:packageId/export-aconex")
  @HttpCode(202)
  exportAconex(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Param("packageId") packageId: string, @Body() body: unknown) {
    return this.service.exportPackage(req.auth!, projectId, packageId, "aconex_bundle", api.idempotencyKey(req.headers, api.object(body)), req);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/dashboard/status")
  dashboard(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, unknown>) {
    return this.service.dashboard(req.auth!, projectId, query);
  }

  @Get("audit-events")
  audit(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.auditExport(req.auth!, null, query);
  }

  @RequirePermission("read", "projectId")
  @Get("projects/:projectId/audit-events")
  projectAudit(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Query() query: Record<string, unknown>) {
    return this.service.auditExport(req.auth!, projectId, query);
  }

  @RequirePermission("review", "projectId")
  @Post("projects/:projectId/learning-events")
  learning(@Req() req: AuthedRequest, @Param("projectId") projectId: string, @Body() body: unknown) {
    return this.service.recordLearningEvent(req.auth!, projectId, api.object(body), req);
  }

  @Get("learning-consent")
  getLearningConsent(@Req() req: AuthedRequest) {
    return this.service.getLearningConsent(req.auth!);
  }

  @Get("branding")
  getBranding(@Req() req: AuthedRequest) {
    return this.service.getBranding(req.auth!);
  }

  @Patch("branding")
  updateBranding(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.updateBranding(req.auth!, api.object(body), req);
  }

  @Post("learning-consent")
  setLearningConsent(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.setLearningConsent(req.auth!, api.object(body), req);
  }

  @Get("learning-patterns")
  learningPatterns(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.learningAggregate(req.auth!, query);
  }

  @Get("subscription")
  subscription(@Req() req: AuthedRequest) {
    return this.service.subscription(req.auth!);
  }

  @Post("subscription/trial")
  startTrial(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.service.startTrial(req.auth!, api.object(body), req);
  }

  @Get("help")
  contextualHelp(@Query() query: Record<string, unknown>) {
    return this.service.contextualHelp(query);
  }

  @Get("integrations/connections")
  connections(@Req() req: AuthedRequest) {
    return this.service.listConnections(req.auth!);
  }

  @Get("integrations/connections/:connectionId/mappings")
  mappings(@Req() req: AuthedRequest, @Param("connectionId") connectionId: string) {
    return this.service.listMappings(req.auth!, connectionId);
  }

  @Post("integrations/connections/:connectionId/mappings")
  createMapping(@Req() req: AuthedRequest, @Param("connectionId") connectionId: string, @Body() body: unknown) {
    return this.service.createMapping(req.auth!, connectionId, api.object(body), req);
  }

  @Post("integrations/connections/:connectionId/sync-jobs")
  createSyncJob(@Req() req: AuthedRequest, @Param("connectionId") connectionId: string, @Body() body: unknown) {
    const input = api.object(body);
    return this.service.createSyncJob(req.auth!, connectionId, input, api.idempotencyKey(req.headers, input), req);
  }

  @Get("integrations/sync-jobs/:jobId")
  syncJob(@Req() req: AuthedRequest, @Param("jobId") jobId: string) {
    return this.service.syncJobStatus(req.auth!, jobId);
  }

  @Get("integrations/errors")
  integrationErrors(@Req() req: AuthedRequest, @Query() query: Record<string, unknown>) {
    return this.service.integrationErrors(req.auth!, query);
  }
}
