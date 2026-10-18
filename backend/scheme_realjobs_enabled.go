//go:build schemetest

package main

// allowTestOnlyAdaptersForJobs is true only in the disposable integration test
// binary. That binary is built by backend/tests/run_scheme_conversion_*.py with
// `-tags schemetest`, runs against a temporary rule directory and a temporary
// database, and holds no real project data. Production images build with the
// plain `go build` in backend/Dockerfile and therefore never see this value.
//
// It is a build-tag constant rather than an environment variable or a field in
// the rule file on purpose: a rule file must not be able to make itself eligible
// for real project data, and a deployment switch would just move the same label
// outside the data while still being flippable by whoever ships the deployment.
// See scheme_realjobs_disabled.go for the other half.
const allowTestOnlyAdaptersForJobs = true
