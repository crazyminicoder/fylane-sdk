/** Resource shapes, exactly as the API serialises them. */

export interface FylaneFile {
  readonly id: string;
  readonly object: 'file';
  readonly state: string;
  readonly state_reason: string | null;
  readonly filename: string;
  readonly declared_mime: string | null;
  readonly detected_mime: string | null;
  readonly byte_size: number | null;
  readonly findings: unknown;
  readonly created_at: string;
}

export interface Artifact {
  readonly id: string;
  readonly role: string;
  readonly mime: string;
  readonly byte_size: number;
}

export interface Job {
  readonly id: string;
  readonly object: 'job';
  readonly file_id: string;
  readonly operation: string | null;
  readonly preset: string | null;
  readonly state: string;
  readonly class: string;
  readonly credits_estimated: number | null;
  readonly credits_charged: number | null;
  readonly error: { readonly code?: string; readonly message?: string } | null;
  readonly artifacts: readonly Artifact[];
  readonly queued_at: string | null;
  readonly finished_at: string | null;
  /**
   * Present only while the job is `running` and the task has reported; absent
   * otherwise, so its absence carries no meaning.
   */
  readonly progress?: JobProgress;
}

export interface JobProgress {
  readonly phase: 'downloading' | 'processing' | 'uploading';
  /** Over the whole job, 0–100, not over the current phase. */
  readonly percent: number;
  /** What the work is on now, when the operation knows: "page 3 of 12". */
  readonly detail?: string;
  readonly at?: string;
}

export interface Usage {
  readonly object: 'usage';
  readonly credits: {
    readonly granted: number;
    readonly reserved: number;
    readonly consumed: number;
    readonly available: number;
  };
  readonly monthly_free_credits: number;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly object: 'webhook_endpoint';
  readonly url: string;
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly disabled_reason: string | null;
  readonly created_at: string;
  /** Present exactly once, on the response that created the endpoint. */
  readonly signing_secret?: string;
}

export interface List<T> {
  readonly object: 'list';
  readonly data: readonly T[];
  readonly has_more: boolean;
}

/** Bytes, a Blob, or a filesystem path (Node only). */
export type UploadInput = Uint8Array | ArrayBuffer | Blob | string;

export interface UploadValidation {
  /** Allowed detected formats, by extension ("pdf") or MIME ("application/pdf"). */
  readonly formats?: readonly string[];
  readonly maxBytes?: number;
  readonly minBytes?: number;
}

export interface UploadOptions {
  readonly filename?: string;
  readonly mimeType?: string;
  /** Judged against the detected bytes at completion, never the declared type. */
  readonly validation?: UploadValidation;
}

export interface ProcessOptions extends UploadOptions {
  readonly operation?: string;
  readonly preset?: string;
  /**
   * A pipeline: several catalogue operations as one job, charged the sum of
   * its steps. Mutually exclusive with `operation` and `preset`; the steps
   * share `params`, each reading the keys it knows.
   */
  readonly operations?: readonly string[];
  readonly params?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  /** Wait for the job to finish (the default). `false` returns it queued. */
  readonly poll?: boolean;
  readonly timeoutMs?: number;
}
