// TB-5: the e2e suites reserve far more often per account than a real
// shopper (one cached account per file, dozens of checkouts a minute),
// so the per-user reserve rate limit (10/min in production) is raised
// here. The guard reads it per request; the TB-5 suite sets it back to
// the production value for its own rate-limit tests.
process.env.RESERVE_RATE_LIMIT_PER_MINUTE ??= '1000';
