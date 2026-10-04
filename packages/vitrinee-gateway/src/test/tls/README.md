# Test-only TLS material

`profile-test.key` / `profile-test.crt`: a self-signed P-256 certificate for the
fictitious name `profile.test`, valid 100 years. It exists only so
`../../ucp/platform-profile.test.ts` can run the real pinned HTTPS GET against a
local server (T133 review). It protects nothing and is trusted by nothing but
that test, which passes it as the only CA. Not a credential.
