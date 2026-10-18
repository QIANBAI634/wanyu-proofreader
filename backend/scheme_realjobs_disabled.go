//go:build !schemetest

package main

// allowTestOnlyAdaptersForJobs is false in every build that is not the disposable
// integration test binary — including the one this package's own `go test` runs
// against, which is what lets TestJobAdapterIsTheOnlyGateBetweenARuleSetAndARealJob
// prove the refusal.
//
// The previous gate trusted `rule_status=production` alone. A rule file is data,
// and data can be relabelled: the test harness did exactly that to make the
// synthetic fixture runnable, which is the evidence that the label could not be
// the whole gate. The contract version cannot be relabelled into existence — a v1
// file has no IPA slot — so until #189 ships v2 the answer stays no.
const allowTestOnlyAdaptersForJobs = false
