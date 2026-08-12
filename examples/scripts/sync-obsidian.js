#!/usr/bin/env bun
// Synchronisation d'un dépôt Git de notes Obsidian.
//
// Conçu pour tourner toutes les cinq minutes sans surveillance : il doit être
// silencieux quand tout va bien, et sortir avec un code distinct par cause
// d'échec pour que l'historique de Rota reste lisible.
//
//   0   synchronisé, ou rien à faire
//   10  le répertoire n'est pas un dépôt Git
//   11  un rebase ou une fusion est déjà en cours
//   12  conflit pendant le rebase (annulé proprement)
//   13  dépôt distant injoignable
//   14  push refusé
//   15  authentification refusée par le distant
//
// Le répertoire de travail vient de runner.workingDirectory. Le script n'écrit
// jamais en dehors du dépôt et n'utilise que des commandes git explicites.
//
// Un remote SSH suppose une clé utilisable au moment où la tâche tourne. Si la
// clé n'est pas chargée dans ssh-agent, ssh la déchiffre à chaque exécution en
// lisant sa passphrase dans le trousseau — impossible session verrouillée, et
// l'échec prend alors la forme trompeuse d'un « Permission denied (publickey) ».
// D'où "requiresUnlockedSession": true dans la tâche fournie : Rota ne la
// lance pas écran verrouillé et rattrape au déverrouillage.
//
// L'option --dry-run n'exécute que les commandes de lecture (statut, fetch,
// comptage) et décrit ce qui serait fait. Utile pour vérifier la configuration
// sur un vrai dépôt de notes avant de laisser la tâche s'exécuter seule.
//
// Le script émet « ::rota:changed:: » uniquement quand il a réellement
// commité, intégré du distant ou poussé. Avec "onChange": true dans la tâche,
// c'est la seule situation où une notification part : les dizaines de cycles
// quotidiens qui ne trouvent rien à faire restent silencieux.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const EXIT = {
  OK: 0,
  NOT_A_REPOSITORY: 10,
  ALREADY_IN_PROGRESS: 11,
  REBASE_CONFLICT: 12,
  NETWORK: 13,
  PUSH_REJECTED: 14,
  AUTH: 15,
}

const COMMIT_MESSAGE = process.env.ROTA_COMMIT_MESSAGE ?? 'Automatic Obsidian sync'
const DRY_RUN = process.argv.includes('--dry-run')

// Motifs d'un refus d'authentification. Testés avant les motifs réseau : git
// accompagne « Permission denied (publickey) » d'un « Could not read from
// remote repository » qui, seul, ferait passer un problème de clé pour une
// coupure de connexion.
const AUTH_PATTERNS = [
  /permission denied \(publickey/i,
  /permission denied, please try again/i,
  /too many authentication failures/i,
  /authentication failed/i,
  /repository not found/i,
]

const AUTH_HINT =
  "Vérifie que la clé est chargée dans l'agent : « ssh-add -l ». Si l'agent est vide, " +
  'ssh doit déchiffrer la clé à chaque exécution en lisant sa passphrase dans le ' +
  'trousseau, ce qui échoue dès que la session est verrouillée — ' +
  '« ssh-add --apple-use-keychain ~/.ssh/id_rsa » la charge durablement.'

// Motifs distinguant une panne réseau d'un vrai refus du serveur.
const NETWORK_PATTERNS = [
  /could not resolve host/i,
  /couldn't resolve host/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /network is unreachable/i,
  /could not read from remote repository/i,
  /failed to connect/i,
  /ssh: connect to host/i,
]

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' })

  if (result.error) {
    fail(`git introuvable ou non exécutable : ${result.error.message}`, EXIT.NOT_A_REPOSITORY)
  }
  if (result.status !== 0 && !allowFailure) {
    fail(`échec de « git ${args.join(' ')} » :\n${result.stderr.trim()}`, 1)
  }
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

function log(message) {
  console.log(DRY_RUN ? `[simulation] ${message}` : message)
}

// Résumé de ce qui a réellement changé, agrégé pour n'émettre qu'un marqueur.
const effects = []

/** Les comptages de git arrivent en chaînes : on convertit avant d'accorder. */
function plural(count, singular, pluralForm = `${singular}s`) {
  const n = Number(count)
  return `${n} ${n > 1 ? pluralForm : singular}`
}

function signalChanges() {
  if (DRY_RUN || effects.length === 0) return
  console.log(`::rota:changed:: ${effects.join(', ')}`)
}

function fail(message, code) {
  console.error(message)
  process.exit(code)
}

function isNetworkFailure(text) {
  return NETWORK_PATTERNS.some((pattern) => pattern.test(text))
}

function isAuthFailure(text) {
  return AUTH_PATTERNS.some((pattern) => pattern.test(text))
}

/** Échec d'accès au distant : l'authentification l'emporte sur le réseau. */
function failRemote(what, stderr) {
  if (isAuthFailure(stderr)) {
    fail(`Authentification refusée par le distant ${what} :\n${stderr}\n\n${AUTH_HINT}`, EXIT.AUTH)
  }
  if (isNetworkFailure(stderr)) {
    fail(`Dépôt distant injoignable ${what} :\n${stderr}`, EXIT.NETWORK)
  }
  return false
}

// --- 1. le répertoire est-il bien un dépôt ? --------------------------------

const insideRepo = git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
if (!insideRepo.ok || insideRepo.stdout !== 'true') {
  fail(`${process.cwd()} n'est pas un dépôt Git.`, EXIT.NOT_A_REPOSITORY)
}

const gitDir = git(['rev-parse', '--absolute-git-dir']).stdout

// --- 2. une opération est-elle déjà en cours ? ------------------------------

// Un rebase interrompu laisse l'arbre dans un état intermédiaire : reprendre
// par-dessus produirait un enchevêtrement bien pire que de s'arrêter ici.
for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
  if (existsSync(join(gitDir, marker))) {
    fail(
      `Une opération Git est déjà en cours (${marker}). ` +
        'Termine-la ou annule-la à la main avant la prochaine synchronisation.',
      EXIT.ALREADY_IN_PROGRESS,
    )
  }
}

// --- 3. commit local des modifications --------------------------------------

if (DRY_RUN) {
  // On ne veut même pas indexer : `git add -A` modifierait déjà le dépôt.
  const pending = git(['status', '--porcelain']).stdout.split('\n').filter(Boolean)
  if (pending.length > 0) {
    log(`${pending.length} fichier(s) seraient commités :`)
    for (const line of pending.slice(0, 10)) log(`    ${line}`)
    if (pending.length > 10) log(`    … et ${pending.length - 10} autre(s)`)
  } else {
    log('Aucune modification locale')
  }
} else {
  git(['add', '-A'])

  const hasStagedChanges = !git(['diff', '--cached', '--quiet'], { allowFailure: true }).ok
  if (hasStagedChanges) {
    const summary = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean)
    git(['commit', '-m', COMMIT_MESSAGE])
    log(`Commit local : ${summary.length} fichier(s) modifié(s)`)
    effects.push(plural(summary.length, 'fichier commité', 'fichiers commités'))
  } else {
    log('Aucune modification locale')
  }
}

// --- 4. récupération du distant ---------------------------------------------

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout
const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
  allowFailure: true,
})

if (!upstream.ok) {
  fail(
    `La branche « ${branch} » n'a pas de branche distante associée. ` +
      `Lance « git push -u origin ${branch} » une première fois.`,
    1,
  )
}

const fetched = git(['fetch', '--quiet'], { allowFailure: true })
if (!fetched.ok) {
  failRemote('pendant le fetch', fetched.stderr)
  fail(`Échec de git fetch :\n${fetched.stderr}`, 1)
}

// --- 5. rebase sur le distant ------------------------------------------------

const behind = git(['rev-list', '--count', `HEAD..${upstream.stdout}`]).stdout
if (DRY_RUN) {
  if (behind !== '0') log(`Rebase sur ${upstream.stdout} : ${behind} commit(s) distant(s) à intégrer`)
  const aheadNow = git(['rev-list', '--count', `${upstream.stdout}..HEAD`]).stdout
  log(aheadNow === '0' ? 'Rien à pousser' : `${aheadNow} commit(s) seraient poussés`)
  log('Aucune modification effectuée.')
  process.exit(EXIT.OK)
}

if (behind !== '0') {
  const rebased = git(['rebase', upstream.stdout], { allowFailure: true })
  if (!rebased.ok) {
    // On ne laisse jamais le dépôt à moitié rebasé : Obsidian rouvrirait des
    // fichiers pleins de marqueurs de conflit.
    git(['rebase', '--abort'], { allowFailure: true })
    fail(
      `Conflit pendant le rebase, annulé. Résous-le à la main :\n${rebased.stdout}\n${rebased.stderr}`,
      EXIT.REBASE_CONFLICT,
    )
  }
  log(`Rebase sur ${upstream.stdout} : ${behind} commit(s) distant(s) intégré(s)`)
  effects.push(plural(behind, 'commit distant intégré', 'commits distants intégrés'))
}

// --- 6. push -----------------------------------------------------------------

const ahead = git(['rev-list', '--count', `${upstream.stdout}..HEAD`]).stdout
if (ahead === '0') {
  log('Rien à pousser, dépôt synchronisé')
  signalChanges()
  process.exit(EXIT.OK)
}

const pushed = git(['push', '--quiet'], { allowFailure: true })
if (!pushed.ok) {
  failRemote('pendant le push', pushed.stderr)
  fail(
    `Push refusé (le distant a probablement avancé entre-temps) :\n${pushed.stderr}`,
    EXIT.PUSH_REJECTED,
  )
}

log(`${ahead} commit(s) poussé(s) sur ${upstream.stdout}`)
effects.push(plural(ahead, 'commit poussé', 'commits poussés'))
signalChanges()
process.exit(EXIT.OK)
