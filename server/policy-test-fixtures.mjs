// Synthetic asset identities for local test approvals only. This data helper
// observes no served bytes, approves no notice and is never a runtime dependency.
export function syntheticPolicyProof({origin,sourceCommit,version,locales=['en']}) {
  return {origin,sourceCommit,assetsSha256:'b'.repeat(64),locales:Object.fromEntries(locales.map(locale=>
    [locale,{version,privacySha256:'c'.repeat(64),usageSha256:'d'.repeat(64)}]))};
}
