/**
 * Permission strings, mirroring backend/src/auth/permission-policy.json.
 * The backend is the enforcement layer; these gate what the UI *offers* so we
 * never render an action the user will be 403'd on.
 */
export const PERM = {
  projectRead: "project.read",
  projectManage: "project.manage",
  documentRead: "document.read",
  documentUpload: "document.upload",
  registerRead: "register.read",
  registerManage: "register.manage",
  submittalApprove: "submittal.approve",
  riskReview: "risk.review",
  rfiManage: "rfi.manage",
  productMatch: "product.match",
  vendorManage: "vendor.manage",
  packageManage: "package.manage",
  integrationManage: "integration.manage",
  billingManage: "billing.manage",
  contentAuthor: "content.author",
  memberManage: "member.manage",
  auditRead: "audit.read",
} as const;

export type Permission = (typeof PERM)[keyof typeof PERM];

export function can(
  permissions: string[] | undefined,
  permission: Permission,
): boolean {
  return !!permissions?.includes(permission);
}
