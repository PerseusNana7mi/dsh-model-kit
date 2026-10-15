import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectFragments, compareVersions, git, parseVersion, readPackage, renderNotes } from './release-notes.mjs'

const OUTPUT_DIR = 'work/release'

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function releaseVersion(release) {
  if (!/^v/.test(release.tag_name)) return undefined
  try {
    parseVersion(release.tag_name.slice(1))
    return release.tag_name.slice(1)
  } catch {
    return undefined
  }
}

export function selectPreviousRelease(cwd, releases, targetSha, version, dryRun) {
  const published = releases.filter((release) => !release.draft && releaseVersion(release))
  if (!dryRun && published.some((release) => compareVersions(releaseVersion(release), version) >= 0)) {
    throw new Error('Release version must be newer than every published version; bump package.json and lockfile')
  }
  const candidates = published
    .filter((release) => compareVersions(releaseVersion(release), version) <= 0)
    .sort((a, b) => compareVersions(releaseVersion(b), releaseVersion(a)))
  const previous = candidates[0]
  if (previous) {
    // A missing/divergent published tag must not silently produce incomplete notes.
    git(cwd, ['merge-base', '--is-ancestor', `refs/tags/${previous.tag_name}`, targetSha])
    return previous.tag_name
  }
  return null
}

export async function createPlan(cwd, releases, dryRun = false) {
  const { name, version } = await readPackage(cwd)
  const targetSha = git(cwd, ['rev-parse', 'HEAD'])
  const tag = `v${version}`
  if (!dryRun && releases.some((release) => release.tag_name === tag)) {
    throw new Error(`Release or draft already exists: ${tag}; it will not be overwritten`)
  }
  if (!dryRun && git(cwd, ['tag', '--list', tag])) throw new Error(`Tag already exists: ${tag}`)
  const previousTag = selectPreviousRelease(cwd, releases, targetSha, version, dryRun)
  const fragments = await collectFragments(cwd, previousTag)
  return {
    manifest: {
      schemaVersion: 1,
      packageName: name,
      version,
      tag,
      targetSha,
      previousTag,
      prerelease: Boolean(parseVersion(version).pre),
      fragmentFiles: fragments.files,
    },
    notes: renderNotes(fragments.changes),
  }
}

function assertWorkflow(cwd) {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY ?? '') ||
    git(cwd, ['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA
  ) {
    throw new Error('Publishing is only supported by workflow_dispatch on main at the triggering commit')
  }
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release checkout must be clean')
  }
}

function listReleases() {
  return JSON.parse(gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/releases`, '--paginate', '--slurp'])).flat()
}

async function savePlan(cwd, plan) {
  const directory = join(cwd, OUTPUT_DIR)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'notes.md'), plan.notes)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`)
}

function checksum(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sealBundle(cwd) {
  const directory = join(cwd, OUTPUT_DIR)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const tarball = `${manifest.packageName}-${manifest.version}.tgz`
  const packedFiles = (await readdir(directory)).filter((file) => file.endsWith('.tgz'))
  if (packedFiles.length !== 1 || packedFiles[0] !== tarball) throw new Error('Expected exactly one versioned tarball')
  const archivePath = join(directory, tarball)
  const packed = JSON.parse(execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], { encoding: 'utf8' }))
  if (packed.name !== manifest.packageName || packed.version !== manifest.version) {
    throw new Error('Tarball name/version does not match the release manifest')
  }
  const entries = execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8' }).split(/\r?\n/)
  for (const required of ['package/lib/index.js', 'package/lib/client.js', 'package/LICENSE']) {
    if (!entries.includes(required)) throw new Error(`Tarball is missing ${required}`)
  }
  manifest.tarball = tarball
  manifest.sha256 = checksum(await readFile(archivePath))
  await writeFile(join(directory, 'SHA256SUMS'), `${manifest.sha256}  ${tarball}\n`)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function verifyBundle(cwd, plan) {
  const directory = join(cwd, OUTPUT_DIR)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const { tarball, sha256, ...original } = manifest
  if (JSON.stringify(original) !== JSON.stringify(plan.manifest)) throw new Error('Release manifest changed')
  if (tarball !== `${manifest.packageName}-${manifest.version}.tgz`) throw new Error('Unexpected tarball filename')
  if (checksum(await readFile(join(directory, tarball))) !== sha256) throw new Error('Tarball checksum mismatch')
  if ((await readFile(join(directory, 'SHA256SUMS'), 'utf8')) !== `${sha256}  ${tarball}\n`) {
    throw new Error('SHA256SUMS changed')
  }
  if ((await readFile(join(directory, 'notes.md'), 'utf8')) !== plan.notes) throw new Error('Release notes changed')
  return manifest
}

export async function publishBundle(cwd, plan, repository, runGh = gh) {
  const manifest = await verifyBundle(cwd, plan)
  const directory = join(cwd, OUTPUT_DIR)
  const flags = manifest.prerelease ? ['--prerelease', '--latest=false'] : ['--latest']
  // Claim the tag atomically at the tested SHA; never reuse another writer's tag.
  runGh([
    'api',
    '--method',
    'POST',
    `repos/${repository}/git/refs`,
    '-f',
    `ref=refs/tags/${manifest.tag}`,
    '-f',
    `sha=${manifest.targetSha}`,
  ])
  return runGh([
    'release',
    'create',
    manifest.tag,
    join(directory, manifest.tarball),
    join(directory, 'SHA256SUMS'),
    '--repo',
    repository,
    '--target',
    manifest.targetSha,
    '--verify-tag',
    '--title',
    manifest.tag,
    '--notes-file',
    join(directory, 'notes.md'),
    ...flags,
  ])
}

async function main() {
  const cwd = process.cwd()
  const [command, ...args] = process.argv.slice(2)
  if (command === 'notes') {
    if (args.length !== 2 || args[0] !== '--from' || !/^v[0-9A-Za-z.-]+$/.test(args[1])) {
      throw new Error('Usage: npm run release:notes -- --from v0.1.4')
    }
    parseVersion(args[1].slice(1))
    const fragments = await collectFragments(cwd, args[1])
    const directory = join(cwd, OUTPUT_DIR)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'notes.md'), renderNotes(fragments.changes))
    console.log(`Preview: ${OUTPUT_DIR}/notes.md (${fragments.files.length} fragments)`)
    return
  }
  if (command === 'seal') {
    const manifest = await sealBundle(cwd)
    console.log(`Packed ${manifest.tarball}: ${manifest.sha256}`)
    return
  }
  if (!['prepare', 'publish'].includes(command) || args.length) throw new Error('Unknown release command')
  assertWorkflow(cwd)
  const dryRun = command === 'prepare' && process.env.RELEASE_DRY_RUN === 'true'
  const plan = await createPlan(cwd, listReleases(), dryRun)
  if (command === 'prepare') {
    await savePlan(cwd, plan)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `# ${dryRun ? 'Dry run' : 'Release'} ${plan.manifest.tag}\n\nCommit: ${plan.manifest.targetSha}\n\n${plan.notes}`,
    )
    return
  }
  if (process.env.RELEASE_DRY_RUN === 'true') throw new Error('Dry runs cannot publish')
  const url = await publishBundle(cwd, plan, process.env.GITHUB_REPOSITORY)
  console.log(url)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `Published ${plan.manifest.tag}: ${url}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
