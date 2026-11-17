import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [email, role] = process.argv.slice(2);
const allowed = new Set(['dataController', 'adminClerk', 'doctor', 'nurse', 'midwife', 'bhw']);

if (!email || !allowed.has(role)) {
  console.error('Usage: npm run set-role -- <existing-user-email> <dataController|adminClerk|doctor|nurse|midwife|bhw>');
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });

try {
  const user = await getAuth().getUserByEmail(email);
  await getAuth().setCustomUserClaims(user.uid, { ...(user.customClaims || {}), role });
  console.log(`Assigned role "${role}" to ${email} (uid: ${user.uid}).`);
  console.log('The user must sign in again or refresh their ID token for the claim to appear.');
} catch (error) {
  console.error('Role assignment failed:', error.message);
  process.exitCode = 1;
}
