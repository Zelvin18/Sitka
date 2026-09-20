// Pins the extension's identity.
//
// An unpacked extension's ID comes from the folder it is loaded from, and
// the Chrome Web Store gives a published one its own. Pinning a key in the
// manifest makes the ID the same everywhere, forever, so the Google sign-in
// redirect (https://<id>.chromiumapp.org/google) never has to change again.
//
// Run once, from the project root:   node extension/pin-key.js
// Then add the printed redirect URL to the Google OAuth client, reload the
// extension in chrome://extensions, and commit the manifest (the private
// key, extension/key.pem, stays out of git; keep it somewhere safe).

const { generateKeyPairSync, createHash } = require('crypto')
const fs = require('fs')
const path = require('path')

const manifestPath = path.join(__dirname, 'static', 'manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (manifest.key) {
  console.log('The manifest already carries a key. Remove "key" from it first if you truly want a new identity.')
  process.exit(0)
}
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const der = publicKey.export({ type: 'spki', format: 'der' })
const id = createHash('sha256')
  .update(der)
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)))
fs.writeFileSync(path.join(__dirname, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
manifest.key = der.toString('base64')
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('Extension ID:', id)
console.log('Add this redirect URL to the Google OAuth client:')
console.log(`  https://${id}.chromiumapp.org/google`)
console.log('Private key written to extension/key.pem (kept out of git).')
