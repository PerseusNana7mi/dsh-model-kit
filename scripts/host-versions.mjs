export const CURRENT_HOST = '0.2.1-rc.5'
export const LEGACY_HOST = '0.2.0-rc.2'

// Change only development dependencies. Exercise the same published dependency
// and peer declarations on both hosts, including the exact Schemastery version.
export function legacyManifest(manifest) {
  const result = structuredClone(manifest)
  for (const name of Object.keys(result.devDependencies)) {
    if (name.startsWith('@deepseek-ai/dsh-')) result.devDependencies[name] = LEGACY_HOST
  }
  result.devDependencies['@deepseek-ai/cordis'] = '4.0.4'
  result.devDependencies['@deepseek-ai/cordis-plugin-loader'] = '1.0.5'
  return result
}
