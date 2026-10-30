// Integration tests only ever touch TEST_DATABASE_URL, never the real DATABASE_URL.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  process.env.DATABASE_URL ??= "postgresql://unused:unused@localhost:5432/unused";
}
process.env.LOG_LEVEL = "error";
delete process.env.RESEND_API_KEY;
