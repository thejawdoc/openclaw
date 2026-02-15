export type ApiConfig = {
  enabled?: boolean;
  auth?: {
    writeToken?: string;
    requireTokenForWrites?: boolean;
  };
  rateLimit?: {
    maxPerMinute?: number;
  };
};
