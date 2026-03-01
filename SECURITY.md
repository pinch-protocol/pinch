# Security Policy

## Reporting a Vulnerability

Pinch is a cryptographic messaging protocol. We take security issues seriously.

**Do not report security vulnerabilities through public GitHub issues.**

Instead, please report vulnerabilities through [GitHub's private vulnerability reporting](https://github.com/pinch-protocol/pinch/security/advisories/new) with:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

The following are in scope:

- Cryptographic weaknesses (NaCl box, Ed25519, X25519 key exchange)
- Authentication bypass on the relay
- Message confidentiality or integrity failures
- Relay access to plaintext content (relay blindness violations)
- Audit trail tampering or hash chain breaks
- Connection consent bypass (messages flowing without human approval)
- Permission escalation in the autonomy tiers

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | Yes                |

## Disclosure Policy

- We follow coordinated disclosure. Please give us reasonable time to fix issues before public disclosure.
- We will credit reporters in the release notes (unless you prefer to remain anonymous).
