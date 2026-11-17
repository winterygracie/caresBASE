# Ampayon Care-Sync — Firebase database backend

This repository contains the **database/backend source only** for Ampayon Care-Sync. It uses Firebase Authentication, Cloud Firestore, and second-generation callable Cloud Functions.

> This is a development foundation, not a production-ready electronic health record. Do not enter real patient information until the health center has approved the privacy, security, retention, backup, and access-control arrangements and the system has been reviewed by qualified personnel.

## Included

- Firestore security rules: client writes are denied; privileged changes go through authenticated Cloud Functions.
- Role-based authorization using Firebase Authentication custom claims.
- Patient registration with a server-generated Patient ID and duplicate-identity guard.
- Appointment creation and status updates.
- Medicine inventory receiving and FEFO dispensing from expiry-dated batches.
- Server-written audit logs.
- A local bootstrap script for assigning the first Data Controller role.

## Roles

Supported role claims: `dataController`, `adminClerk`, `doctor`, `nurse`, `midwife`, and `bhw`.

Roles are **not** selected by users during signup. A trusted Data Controller assigns roles through the protected callable function after the first Data Controller is provisioned using the local Admin SDK script.

## Requirements

- A Firebase project with the Blaze plan for deployed Cloud Functions (billing may apply).
- Node.js 20 or later.
- Firebase CLI: `npm install -g firebase-tools`.

## Setup

1. Create or select a Firebase project in the Firebase Console.
2. Enable **Authentication → Email/Password** and create a Firestore database.
3. In this repository, install the CLI and sign in:

   ```bash
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

   Select your Firebase project. The selected project alias is written to your local `.firebaserc`; do not commit credentials or service-account keys.

4. Install the backend dependencies:

   ```bash
   cd functions
   npm install
   cd ..
   ```

5. Set the private HMAC key used to create non-reversible duplicate-check identity keys:

   ```bash
   firebase functions:secrets:set PATIENT_ID_HMAC_KEY
   ```

   Use a long, random secret generated in a password manager. Do not put it in source code, GitHub, chat, or a frontend environment variable. Back it up securely; rotating it without a migration plan changes identity keys and can weaken duplicate detection.

6. Deploy rules, indexes, and functions:

   ```bash
   firebase deploy --only firestore:rules,firestore:indexes,functions
   ```

## Provision the first Data Controller

The first Data Controller cannot be appointed from an untrusted client. Use a trusted administrator workstation with a service-account credential that has Firebase Admin privileges. Keep the credential outside this repository.

PowerShell example:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\secure\firebase-admin.json"
cd functions
npm install
npm run set-role -- data-controller@example.org dataController
```

Replace the email with the approved account. The script accepts only an existing Firebase Authentication user. Remove the credential from the workstation when finished. Never upload it to GitHub.

After the first Data Controller signs in again (or refreshes their ID token), they can assign the other approved roles using the `setUserRole` callable function.

## Callable functions

All functions require a signed-in Firebase Authentication user. Authorization is checked on the server using the user's custom claim `role`.

- `createPatient`: authorized registration staff; server assigns a unique Patient ID after checking a keyed identity match.
- `createAppointment`: appointment staff and authorized clinical roles.
- `updateAppointmentStatus`: authorized appointment/clinical roles.
- `receiveStock`: inventory staff; records a batch and increments stock.
- `dispenseStock`: inventory staff; consumes earliest-expiring eligible batches first (FEFO).
- `setUserRole`: Data Controller only.

The Firebase Admin SDK bypasses Firestore client rules. Therefore, every callable function must continue to enforce authorization and validate its inputs.

## Data collections

- `patients/{patientId}`
- `_privatePatientIdentityKeys/{hmacKey}` (server-only)
- `_systemCounters/patientIds` (server-only)
- `appointments/{appointmentId}`
- `inventoryItems/{medicineId}`
- `inventoryItems/{medicineId}/batches/{batchId}`
- `auditLogs/{auditId}`
- `users/{uid}` (minimal staff profile; role is held in the Auth custom claim)

## Important security and privacy notes

- Firestore rules deny direct client writes to all clinical, inventory, identity-key, counter, and audit collections.
- Do not store passwords in Firestore. Firebase Authentication handles credentials.
- Do not place service-account JSON, HMAC keys, API secrets, or patient records in this repository.
- Patient identity matching uses an HMAC of normalized name, date of birth, and sex-at-birth. This is a duplicate guard, not proof that two records belong to the same person; staff must verify possible matches before registration. A shared name and birth date can produce a false positive.
- FEFO dispensing is performed in a Firestore transaction and rejects expired batches and insufficient stock.
- Audit entries avoid copying patient clinical details.
- Review field-level access, consent, retention, breach response, backup/restore, and applicable Philippine Data Privacy Act requirements before real-world use. Firestore collection-level rules do not provide field-level redaction; use trusted server endpoints for any role that should see only a subset of patient fields.
- Test with fictional records only.

## Local emulator

Install the Firebase Emulator Suite, then run:

```bash
firebase emulators:start --only auth,firestore,functions
```

The frontend is intentionally not included in this repository. Its Firebase client integration should call these callable functions rather than writing protected collections directly.
