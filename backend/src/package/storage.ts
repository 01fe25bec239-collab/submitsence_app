import { GetBucketLocationCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { PackageDocumentRef } from "./package.types";

const AU_REGIONS = new Set(["ap-southeast-2", "ap-southeast-4"]);

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

export interface ObjectStore {
  get(document: PackageDocumentRef): Promise<Uint8Array>;
  put(input: PutObjectInput): Promise<{ versionId: string | null }>;
  assertAustralianBucket(bucket: string): Promise<string>;
}

export class S3ObjectStore implements ObjectStore {
  private readonly clients = new Map<string, S3Client>();
  private readonly bucketRegions = new Map<string, string>();

  private client(region: string) {
    let client = this.clients.get(region);
    if (!client) {
      client = new S3Client({ region, followRegionRedirects: true });
      this.clients.set(region, client);
    }
    return client;
  }

  async assertAustralianBucket(bucket: string): Promise<string> {
    const cached = this.bucketRegions.get(bucket);
    if (cached) return cached;
    const configuredRegion = process.env.AWS_REGION ?? "ap-southeast-2";
    const result = await this.client(configuredRegion).send(new GetBucketLocationCommand({ Bucket: bucket }));
    const region = result.LocationConstraint || "us-east-1";
    if (!AU_REGIONS.has(region)) throw new Error(`Generated package bucket must be in an Australian AWS region; ${bucket} is in ${region}`);
    this.bucketRegions.set(bucket, region);
    return region;
  }

  async get(document: PackageDocumentRef): Promise<Uint8Array> {
    const region = await this.assertAustralianBucket(document.storageBucket);
    const result = await this.client(region).send(new GetObjectCommand({ Bucket: document.storageBucket, Key: document.objectKey }));
    if (!result.Body) throw new Error("S3 object has no body");
    return result.Body.transformToByteArray();
  }

  async put(input: PutObjectInput): Promise<{ versionId: string | null }> {
    const region = await this.assertAustralianBucket(input.bucket);
    const result = await this.client(region).send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ServerSideEncryption: process.env.S3_KMS_KEY_ARN ? "aws:kms" : "AES256",
      SSEKMSKeyId: process.env.S3_KMS_KEY_ARN,
      Metadata: input.metadata,
    }));
    return { versionId: result.VersionId ?? null };
  }
}
