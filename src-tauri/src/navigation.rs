//! Navigation policy for the Portal webview.
//!
//! This module is deliberately free of any Tauri types so the policy can be
//! unit-tested as a pure function. `lib.rs` is the only place that adapts it to
//! the webview's `on_navigation` hook.

use url::Url;

/// What the webview should do with a navigation request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Navigate in-app. Reserved for the trusted hosts.
    Allow,
    /// Hand off to the user's default browser and cancel the in-app navigation.
    OpenExternally,
    /// Cancel outright; never leaves the app and never reaches the browser.
    Block,
}

/// The set of hosts this shell will navigate to in-app.
///
/// This is a *set*, not a single host, because sign-in legitimately spans two
/// origins: Portal itself, and the Authentik identity provider it redirects to
/// for OIDC. Allowing only Portal sends the `/application/o/authorize/` hop to
/// the system browser, and the session never comes back to the app.
#[derive(Debug, Clone)]
pub struct Policy {
    allowed_hosts: Vec<String>,
}

impl Policy {
    /// Build a policy from the hosts to trust. Hosts are lowercased once here
    /// so comparison is a plain equality check.
    pub fn new<I, S>(hosts: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut allowed_hosts: Vec<String> = hosts
            .into_iter()
            .map(|h| h.as_ref().trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
        allowed_hosts.sort();
        allowed_hosts.dedup();
        Self { allowed_hosts }
    }

    pub fn allowed_hosts(&self) -> &[String] {
        &self.allowed_hosts
    }

    /// Exact, case-insensitive host match against the trusted set.
    ///
    /// Exactness is the point: suffix or `contains` matching would accept
    /// `portal.caelonhq.com.evil.com`, and prefix matching would accept
    /// `evil.portal.caelonhq.com`. Subdomains are not trusted implicitly.
    fn is_trusted_host(&self, url: &Url) -> bool {
        match url.host_str() {
            Some(host) => {
                let host = host.to_ascii_lowercase();
                self.allowed_hosts.iter().any(|allowed| *allowed == host)
            }
            None => false,
        }
    }

    /// Decide how to handle `url`.
    ///
    /// The rules are intentionally strict: this app is a shell around a small,
    /// fixed set of origins, so anything else is either punted to the browser
    /// or dropped.
    pub fn decide(&self, url: &Url) -> Decision {
        // `about:blank` is what a webview navigates to internally (e.g. the
        // initial empty document). Blocking it can wedge the webview, and it
        // carries no content of its own, so it is safe to permit.
        if url.scheme() == "about" {
            return match url.path() {
                "blank" | "srcdoc" => Decision::Allow,
                _ => Decision::Block,
            };
        }

        match url.scheme() {
            "https" => {
                if self.is_trusted_host(url) {
                    Decision::Allow
                } else {
                    Decision::OpenExternally
                }
            }
            // Plain HTTP on a trusted host is a protocol downgrade: session
            // cookies would go out in the clear. Refuse rather than silently
            // upgrade, so the failure is visible instead of quietly insecure.
            "http" => {
                if self.is_trusted_host(url) {
                    Decision::Block
                } else {
                    Decision::OpenExternally
                }
            }
            // file:, data:, javascript:, blob: and any custom scheme. None of
            // these have a legitimate reason to appear in a remote-origin shell,
            // and each is a known escalation vector, so none of them reach the
            // browser either.
            _ => Decision::Block,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORTAL: &str = "portal.caelonhq.com";
    const AUTH: &str = "auth.caelonhq.com";

    fn policy() -> Policy {
        Policy::new([PORTAL, AUTH])
    }

    fn decide_str(raw: &str) -> Decision {
        let url = Url::parse(raw).unwrap_or_else(|e| panic!("failed to parse {raw}: {e}"));
        policy().decide(&url)
    }

    // ----------------------------------------------------------- trusted hosts

    #[test]
    fn allows_portal_origin_over_https() {
        assert_eq!(decide_str("https://portal.caelonhq.com/"), Decision::Allow);
        assert_eq!(
            decide_str("https://portal.caelonhq.com/dashboard"),
            Decision::Allow
        );
        assert_eq!(
            decide_str("https://portal.caelonhq.com/api/auth/get-session"),
            Decision::Allow
        );
    }

    /// Regression test for the blocker found by actually running the app:
    /// Portal delegates sign-in to Authentik on a different host. If this hop
    /// is not allowed in-app, login silently breaks.
    #[test]
    fn allows_the_oidc_authorize_hop_to_authentik() {
        assert_eq!(
            decide_str(
                "https://auth.caelonhq.com/application/o/authorize/?response_type=code&client_id=abc&scope=openid+email+profile&redirect_uri=https%3A%2F%2Fportal.caelonhq.com%2Fapi%2Fauth%2Foauth2%2Fcallback%2Fcustom"
            ),
            Decision::Allow
        );
    }

    #[test]
    fn allows_the_authentik_login_flow_pages() {
        assert_eq!(
            decide_str("https://auth.caelonhq.com/if/flow/default-authentication-flow/?next=%2F"),
            Decision::Allow
        );
    }

    #[test]
    fn allows_the_callback_back_on_portal() {
        assert_eq!(
            decide_str(
                "https://portal.caelonhq.com/api/auth/oauth2/callback/custom?code=xyz&state=abc"
            ),
            Decision::Allow
        );
    }

    #[test]
    fn allows_portal_with_query_fragment_and_port_free_forms() {
        assert_eq!(
            decide_str("https://portal.caelonhq.com/projects?view=board#task-1"),
            Decision::Allow
        );
    }

    #[test]
    fn host_match_is_case_insensitive() {
        assert_eq!(decide_str("https://PORTAL.CaelonHQ.com/"), Decision::Allow);
        assert_eq!(decide_str("https://AUTH.CAELONHQ.COM/"), Decision::Allow);
    }

    #[test]
    fn policy_normalises_and_dedupes_hosts() {
        let p = Policy::new(["  Portal.CaelonHQ.com  ", "portal.caelonhq.com", ""]);
        assert_eq!(p.allowed_hosts(), &["portal.caelonhq.com".to_string()]);
    }

    // -------------------------------------------------------------- downgrades

    #[test]
    fn blocks_protocol_downgrade_on_trusted_hosts() {
        assert_eq!(decide_str("http://portal.caelonhq.com/"), Decision::Block);
        assert_eq!(decide_str("http://auth.caelonhq.com/"), Decision::Block);
    }

    // --------------------------------------------------------- host-match bugs

    #[test]
    fn suffix_lookalike_host_is_not_allowed() {
        // The classic bug: `host.ends_with(allowed)` would accept this.
        assert_eq!(
            decide_str("https://portal.caelonhq.com.evil.com/"),
            Decision::OpenExternally
        );
        assert_eq!(
            decide_str("https://auth.caelonhq.com.attacker.net/"),
            Decision::OpenExternally
        );
    }

    #[test]
    fn subdomains_are_not_implicitly_trusted() {
        // `host.ends_with(".caelonhq.com")` would accept all of these.
        assert_eq!(
            decide_str("https://evil.portal.caelonhq.com/"),
            Decision::OpenExternally
        );
        assert_eq!(
            decide_str("https://staging.caelonhq.com/"),
            Decision::OpenExternally
        );
        assert_eq!(decide_str("https://caelonhq.com/"), Decision::OpenExternally);
    }

    #[test]
    fn prefix_lookalike_host_is_not_allowed() {
        // `host.contains(allowed)` would accept this.
        assert_eq!(
            decide_str("https://notportal.caelonhq.com/"),
            Decision::OpenExternally
        );
    }

    #[test]
    fn userinfo_cannot_spoof_the_host() {
        // Authority confusion: the real host here is evil.com, not Portal.
        assert_eq!(
            decide_str("https://portal.caelonhq.com@evil.com/"),
            Decision::OpenExternally
        );
    }

    #[test]
    fn explicit_port_on_trusted_host_still_matches_host() {
        // We scope on host only; a non-standard port on the real host is still
        // the real host. Asserted so the looser behaviour is intentional.
        assert_eq!(
            decide_str("https://portal.caelonhq.com:8443/"),
            Decision::Allow
        );
    }

    // ------------------------------------------------------------ non-trusted

    #[test]
    fn external_https_goes_to_the_system_browser() {
        assert_eq!(
            decide_str("https://github.com/block/buzz"),
            Decision::OpenExternally
        );
        assert_eq!(
            decide_str("http://example.com/plain"),
            Decision::OpenExternally
        );
    }

    #[test]
    fn about_blank_and_srcdoc_are_permitted() {
        assert_eq!(decide_str("about:blank"), Decision::Allow);
        assert_eq!(decide_str("about:srcdoc"), Decision::Allow);
    }

    #[test]
    fn other_about_urls_are_blocked() {
        assert_eq!(decide_str("about:config"), Decision::Block);
        assert_eq!(decide_str("about:preferences"), Decision::Block);
    }

    #[test]
    fn dangerous_schemes_are_blocked_not_forwarded() {
        // Critically these are Block, not OpenExternally: handing a javascript:
        // or file: URL to the OS opener would be a different bug.
        assert_eq!(decide_str("javascript:alert(1)"), Decision::Block);
        assert_eq!(
            decide_str("file:///C:/Windows/System32/drivers/etc/hosts"),
            Decision::Block
        );
        assert_eq!(
            decide_str("data:text/html,<script>alert(1)</script>"),
            Decision::Block
        );
        assert_eq!(
            decide_str("blob:https://portal.caelonhq.com/abcd"),
            Decision::Block
        );
    }

    #[test]
    fn custom_and_ipc_schemes_are_blocked() {
        assert_eq!(decide_str("caelon://open/project/1"), Decision::Block);
        assert_eq!(decide_str("tauri://localhost"), Decision::Block);
        assert_eq!(decide_str("ms-settings:privacy"), Decision::Block);
    }
}
