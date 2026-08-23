/**
 * Per-worker test bootstrap. Forces local disk storage so the suite is
 * deterministic and NEVER uploads to a real Cloudinary/R2 account, even when
 * .env has STORAGE_PROVIDER=cloudinary with live credentials.
 */
process.env.STORAGE_PROVIDER = 'local';
