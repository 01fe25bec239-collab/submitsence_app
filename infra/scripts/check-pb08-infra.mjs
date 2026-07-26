#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const executable = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*(?:#|\/\/).*$/gm, "");

function block(source, header) {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `missing ${header}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`unterminated ${header}`);
}

const compute = executable(read("terraform/compute.tf"));
const observability = executable(read("terraform/observability.tf"));
const iam = executable(read("terraform/iam.tf"));
const locals = executable(read("terraform/locals.tf"));
const outputs = executable(read("terraform/outputs.tf"));
const bootstrap = executable(read("terraform/bootstrap/main.tf"));
const deployWorkflow = read(".github/workflows/_deploy.yml");
const allTerraform = [compute, observability, iam, locals, outputs, executable(read("terraform/variables.tf"))].join("\n");
const pools = JSON.parse(read("backend/src/worker-pools.json"));
const expectedPools = {
  ocr: { enabled: true, jobTypes: ["ingest_past_submittal"] },
  vendor: { enabled: true, jobTypes: ["ingest_vendor_catalogue", "product_rematch"] },
  package: {
    enabled: true,
    jobTypes: ["package_generation", "export_consultant_pdf", "export_aconex_bundle", "export_register_csv", "export_register_xlsx", "export_register_pdf"],
  },
  scheduled: { enabled: true, anchor: true, jobTypes: ["risk_flag_generation", "rfi_generation"] },
};
assert.deepEqual(pools, expectedPools, "worker-pools.json is not the reviewed PB-08 registry");
const registryMatch = read("backend/src/job-types.ts").match(/asynchronous:\s*\[([\s\S]*?)\]/);
assert.ok(registryMatch, "processing job registry not found");
const supported = [...registryMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const assigned = Object.values(pools).filter((pool) => pool.enabled).flatMap((pool) => pool.jobTypes);
assert.deepEqual([...assigned].sort(), [...supported].sort(), "canonical pools do not cover the backend registry");
assert.equal(new Set(assigned).size, assigned.length, "a JobType is assigned to more than one pool");
assert.equal(Object.values(pools).filter((pool) => pool.enabled && pool.anchor).length, 1, "exactly one enabled anchor is required");
assert.match(locals, /jsondecode\(file\("\$\{path\.module\}\/\.\.\/backend\/src\/worker-pools\.json"\)\)/);

for (const name of ["api", "frontend", "worker"]) {
  assert.match(block(compute, `resource "aws_appautoscaling_target" "${name}"`), /ecs:service:DesiredCount/);
}
for (const name of ["api_cpu", "frontend_cpu"]) {
  const policy = block(compute, `resource "aws_appautoscaling_policy" "${name}"`);
  assert.match(policy, /policy_type\s*=\s*"TargetTrackingScaling"/);
  assert.match(policy, /target_value\s*=\s*60/);
  assert.match(policy, /scale_out_cooldown\s*=\s*60/);
  assert.match(policy, /scale_in_cooldown\s*=\s*300/);
}
for (const [name, adjustment, cooldown] of [["worker_scale_out", "1", "60"], ["worker_scale_in", "-1", "900"]]) {
  const policy = block(compute, `resource "aws_appautoscaling_policy" "${name}"`);
  assert.match(policy, /for_each\s*=\s*local\.worker_services/);
  assert.match(policy, /policy_type\s*=\s*"StepScaling"/);
  assert.match(policy, new RegExp(`cooldown\\s*=\\s*${cooldown}`));
  assert.match(policy, new RegExp(`scaling_adjustment\\s*=\\s*${adjustment}`));
}
assert.doesNotMatch(block(compute, 'resource "aws_appautoscaling_target" "worker"'), /TargetTrackingScaling/);

for (const [name, comparison, evaluations, threshold] of [
  ["worker_scale_out", "GreaterThanOrEqualToThreshold", "1", "1"],
  ["worker_scale_in", "LessThanOrEqualToThreshold", "15", "0"],
]) {
  const alarm = block(observability, `resource "aws_cloudwatch_metric_alarm" "${name}"`);
  assert.match(alarm, /for_each\s*=\s*local\.worker_services/);
  assert.match(alarm, new RegExp(`comparison_operator\\s*=\\s*"${comparison}"`));
  assert.match(alarm, new RegExp(`evaluation_periods\\s*=\\s*${evaluations}`));
  assert.match(alarm, new RegExp(`datapoints_to_alarm\\s*=\\s*${evaluations}`));
  assert.match(alarm, new RegExp(`threshold\\s*=\\s*${threshold}`));
  assert.match(alarm, /treat_missing_data\s*=\s*"notBreaching"/);
  assert.match(alarm, /namespace\s*=\s*"SubmitSense\/Jobs"/);
  assert.match(alarm, /metric_name\s*=\s*"QueueDepth"/);
  assert.match(alarm, /period\s*=\s*60/);
  assert.match(alarm, /stat\s*=\s*"Maximum"/);
  assert.match(alarm, /Environment\s*=\s*var\.environment/);
  assert.match(alarm, /JobType\s*=\s*metric_query\.value\.job_type/);
  assert.doesNotMatch(alarm, /\bFILL\s*\(/);
}

const freshness = block(observability, 'resource "aws_cloudwatch_metric_alarm" "queue_metrics_missing"');
assert.doesNotMatch(freshness, /\bcount\s*=/);
for (const pattern of [
  /period\s*=\s*60/, /evaluation_periods\s*=\s*30/, /datapoints_to_alarm\s*=\s*30/,
  /treat_missing_data\s*=\s*"breaching"/, /alarm_actions\s*=\s*\[aws_sns_topic\.alarms\.arn\]/,
]) assert.match(freshness, pattern);
assert.doesNotMatch(freshness, /aws_appautoscaling_policy/);

const workerTask = block(iam, 'data "aws_iam_policy_document" "worker_task"');
assert.match(workerTask, /"ecs:GetTaskProtection",\s*"ecs:UpdateTaskProtection"/);
assert.doesNotMatch(block(iam, 'data "aws_iam_policy_document" "api_task"'), /TaskProtection/);
assert.match(block(compute, 'resource "aws_ecs_task_definition" "worker"'), /stopTimeout\s*=\s*120/);
assert.match(block(compute, 'resource "aws_ecs_task_definition" "worker"'), /name\s*=\s*"PG_POOL_MAX",\s*value\s*=\s*"3"/);
assert.match(block(compute, 'resource "aws_ecs_task_definition" "api"'), /name\s*=\s*"PG_POOL_MAX"/);
assert.match(block(compute, 'resource "aws_ecs_task_definition" "db_capacity_check"'), /dist\/ops\/check-db-capacity\.js/);
assert.match(outputs, /output "db_capacity_check_task_family"/);

for (const service of ["frontend", "api", "worker"]) {
  const serviceBlock = block(compute, `resource "aws_ecs_service" "${service}"`);
  assert.match(serviceBlock, /ignore_changes\s*=\s*\[desired_count,\s*task_definition\]/);
  assert.match(serviceBlock, /deployment_minimum_healthy_percent\s*=\s*100/);
  assert.match(serviceBlock, /deployment_maximum_percent\s*=\s*200/);
}

const forbidden = /\b(?:WorkerPool|Redis|BullMQ|ElastiCache|package_push|response_pull)\b|(?:^|[^0-9])6379(?:[^0-9]|$)/i;
assert.doesNotMatch(allTerraform, forbidden);
assert.doesNotMatch(allTerraform, /__integration_adapter_pending__|worker-integration|each\.key\s*==\s*"integration"/);
assert.doesNotMatch(allTerraform, /IntegrationFailures/);
assert.doesNotMatch(observability, /OldestJobAgeSeconds[\s\S]{0,200}aws_appautoscaling|aws_cloudwatch_metric_alarm[^}]*OldestJobAgeSeconds/);

assert.match(deployWorkflow, /timeout-minutes:\s*350/);
assert.ok(deployWorkflow.indexOf("Gate database connection capacity in the VPC") < deployWorkflow.indexOf("- name: Run migrations"));
assert.ok(deployWorkflow.indexOf('service="${worker_services[scheduled]}"') > deployWorkflow.indexOf("for name in ocr vendor package"));
assert.match(deployWorkflow, /wait_service "\$api_service" 15/);
assert.match(deployWorkflow, /wait_service "\$frontend_service" 15/);
assert.match(deployWorkflow, /wait_service "\$\{worker_services\[\$name\]\}" 120/);
assert.match(deployWorkflow, /wait_service "\$service" 120/);
assert.match(deployWorkflow, /DEPLOYMENT_BLOCKED/);
assert.match(deployWorkflow, /aws ecs get-task-protection/);
assert.doesNotMatch(deployWorkflow, /aws ecs wait services-stable|aws ecs stop-task|register-scalable-target.*suspend/i);
const metricReads = block(bootstrap, "statement {\n    sid       = \"DeploymentMetricVerification\"");
assert.match(metricReads, /"cloudwatch:GetMetricData",\s*"cloudwatch:ListMetrics"/);
assert.doesNotMatch(metricReads, /PutMetricData|PutMetricAlarm|PutDashboard/);

const expectedCapacity = {
  dev: { api: "{ initial = 1, min = 1, max = 3, pool_max = 5 }", frontend: "{ initial = 1, min = 1, max = 3 }", workers: [1, 1, 1, 2] },
  staging: { api: "{ initial = 2, min = 2, max = 3, pool_max = 10 }", frontend: "{ initial = 2, min = 2, max = 3 }", workers: [2, 2, 2, 3] },
  production: { api: "{ initial = 2, min = 2, max = 10, pool_max = 10 }", frontend: "{ initial = 2, min = 2, max = 10 }", workers: [4, 4, 4, 4] },
};
for (const [environment, expected] of Object.entries(expectedCapacity)) {
  const tfvars = read(`terraform/environments/${environment}.tfvars.example`);
  assert.ok(tfvars.includes(`api_capacity`), `${environment} api capacity missing`);
  assert.ok(tfvars.includes(expected.api), `${environment} api capacity changed`);
  assert.ok(tfvars.includes(expected.frontend), `${environment} frontend capacity changed`);
  for (const [index, name] of ["ocr", "vendor", "package", "scheduled"].entries()) {
    const min = name === "scheduled" ? 1 : 0;
    const initial = name === "scheduled" ? 1 : 0;
    assert.ok(tfvars.includes(`${name}`) && tfvars.includes(`{ initial = ${initial}, min = ${min}, max = ${expected.workers[index]} }`), `${environment} ${name} capacity changed`);
  }
}

console.log("PB-08 executable Terraform, canonical registry, capacity, alarm, scaling, and forbidden-path assertions passed.");
