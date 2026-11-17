import { createHmac } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

initializeApp();
const db = getFirestore();
const REGION = 'asia-southeast1';
const patientIdentityKey = defineSecret('PATIENT_ID_HMAC_KEY');

const ROLES = new Set(['dataController', 'adminClerk', 'doctor', 'nurse', 'midwife', 'bhw']);
const APPOINTMENT_STATUSES = new Set(['scheduled', 'confirmed', 'completed', 'cancelled', 'missed']);

function requireUser(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Please sign in first.');
  return request.auth.uid;
}
function requireRole(request, allowed) {
  const uid = requireUser(request);
  const role = request.auth.token.role;
  if (!ROLES.has(role) || !allowed.includes(role)) {
    throw new HttpsError('permission-denied', 'Your assigned role cannot perform this action.');
  }
  return { uid, role };
}
function cleanString(value, field, max = 120) {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', `${field} is required.`);
  const result = value.trim().replace(/\s+/g, ' ');
  if (!result || result.length > max) throw new HttpsError('invalid-argument', `${field} must be 1-${max} characters.`);
  return result;
}
function validDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpsError('invalid-argument', `${field} must use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpsError('invalid-argument', `${field} is not a valid date.`);
  }
  return value;
}
function positiveInteger(value, field, max = 1000000) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new HttpsError('invalid-argument', `${field} must be a positive whole number.`);
  }
  return value;
}
async function writeAudit(actorUid, action, entityType, entityId, extra = {}) {
  await db.collection('auditLogs').add({
    actorUid, action, entityType, entityId,
    ...extra,
    createdAt: FieldValue.serverTimestamp()
  });
}

export const createPatient = onCall(
  { region: REGION, secrets: [patientIdentityKey] },
  async (request) => {
    const { uid } = requireRole(request, ['dataController', 'adminClerk', 'nurse', 'midwife', 'bhw']);
    const fullName = cleanString(request.data?.fullName, 'Full name', 160);
    const dateOfBirth = validDate(request.data?.dateOfBirth, 'Date of birth');
    const barangay = cleanString(request.data?.barangay, 'Barangay', 100);
    const contactNumber = typeof request.data?.contactNumber === 'string'
      ? request.data.contactNumber.trim().slice(0, 30) : '';
    if (contactNumber && !/^[+0-9()\- ]{7,30}$/.test(contactNumber)) {
      throw new HttpsError('invalid-argument', 'Contact number format is invalid.');
    }
    const identityMaterial = `${fullName.normalize('NFKC').toLowerCase()}|${dateOfBirth}`;
    const identityKey = createHmac('sha256', patientIdentityKey.value()).update(identityMaterial).digest('hex');
    const identityRef = db.collection('_privatePatientIdentityKeys').doc(identityKey);
    const year = new Date().getUTCFullYear();
    const counterRef = db.collection('_systemCounters').doc(`patientIds_${year}`);
    const patientRef = db.collection('patients').doc();

    const patientId = await db.runTransaction(async (tx) => {
      const existing = await tx.get(identityRef);
      if (existing.exists) {
        throw new HttpsError('already-exists', 'A possible matching patient record exists. Ask authorized staff to verify it before creating another profile.');
      }
      const counterSnap = await tx.get(counterRef);
      const next = (counterSnap.exists ? counterSnap.data().value : 0) + 1;
      const generatedId = `AMP-${year}-${String(next).padStart(6, '0')}`;
      tx.set(counterRef, { value: next, updatedAt: FieldValue.serverTimestamp() });
      tx.create(patientRef, {
        patientId: generatedId,
        fullName,
        dateOfBirth,
        barangay,
        contactNumber,
        createdAt: FieldValue.serverTimestamp(),
        createdBy: uid
      });
      tx.create(identityRef, {
        patientId: generatedId,
        createdAt: FieldValue.serverTimestamp()
      });
      return generatedId;
    });
    await writeAudit(uid, 'patient.created', 'patient', patientId);
    return { patientId };
  }
);

export const createAppointment = onCall({ region: REGION }, async (request) => {
  const { uid } = requireRole(request, ['dataController', 'adminClerk', 'doctor', 'nurse', 'midwife']);
  const patientId = cleanString(request.data?.patientId, 'Patient ID', 40);
  const appointmentDate = validDate(request.data?.appointmentDate, 'Appointment date');
  const purpose = cleanString(request.data?.purpose, 'Purpose', 240);
  const patientQuery = await db.collection('patients').where('patientId', '==', patientId).limit(1).get();
  if (patientQuery.empty) throw new HttpsError('not-found', 'Patient record was not found.');
  const ref = db.collection('appointments').doc();
  await ref.set({
    patientId, appointmentDate, purpose, status: 'scheduled',
    createdBy: uid, createdAt: FieldValue.serverTimestamp()
  });
  await writeAudit(uid, 'appointment.created', 'appointment', ref.id);
  return { appointmentId: ref.id };
});

export const updateAppointmentStatus = onCall({ region: REGION }, async (request) => {
  const { uid } = requireRole(request, ['dataController', 'adminClerk', 'doctor', 'nurse', 'midwife']);
  const appointmentId = cleanString(request.data?.appointmentId, 'Appointment ID', 100);
  const status = cleanString(request.data?.status, 'Status', 20);
  if (!APPOINTMENT_STATUSES.has(status)) throw new HttpsError('invalid-argument', 'Unsupported appointment status.');
  const ref = db.collection('appointments').doc(appointmentId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Appointment not found.');
    tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid });
  });
  await writeAudit(uid, 'appointment.status_updated', 'appointment', appointmentId, { status });
  return { success: true };
});

export const receiveStock = onCall({ region: REGION }, async (request) => {
  const { uid } = requireRole(request, ['dataController', 'adminClerk', 'nurse']);
  const medicineId = cleanString(request.data?.medicineId, 'Medicine ID', 80);
  const medicineName = cleanString(request.data?.medicineName, 'Medicine name', 120);
  const unit = cleanString(request.data?.unit, 'Unit', 30);
  const batchNumber = cleanString(request.data?.batchNumber, 'Batch number', 80);
  const expiryDate = validDate(request.data?.expiryDate, 'Expiry date');
  const quantity = positiveInteger(request.data?.quantity, 'Quantity');
  if (expiryDate <= new Date().toISOString().slice(0, 10)) {
    throw new HttpsError('invalid-argument', 'Cannot receive an already expired batch.');
  }
  const itemRef = db.collection('inventoryItems').doc(medicineId);
  const batchRef = itemRef.collection('batches').doc();
  await db.runTransaction(async (tx) => {
    const itemSnap = await tx.get(itemRef);
    if (itemSnap.exists && itemSnap.data().unit !== unit) {
      throw new HttpsError('failed-precondition', 'The unit does not match the existing medicine record.');
    }
    tx.set(itemRef, {
      medicineName, unit,
      onHand: (itemSnap.exists ? itemSnap.data().onHand || 0 : 0) + quantity,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(batchRef, {
      batchNumber, expiryDate, quantityReceived: quantity, quantityAvailable: quantity,
      receivedAt: FieldValue.serverTimestamp(), receivedBy: uid
    });
  });
  await writeAudit(uid, 'inventory.stock_received', 'medicine', medicineId, { quantity, batchNumber });
  return { batchId: batchRef.id };
});

export const dispenseStock = onCall({ region: REGION }, async (request) => {
  const { uid } = requireRole(request, ['dataController', 'adminClerk', 'nurse']);
  const medicineId = cleanString(request.data?.medicineId, 'Medicine ID', 80);
  const quantity = positiveInteger(request.data?.quantity, 'Quantity');
  const itemRef = db.collection('inventoryItems').doc(medicineId);
  const today = new Date().toISOString().slice(0, 10);
  const batchesQuery = itemRef.collection('batches')
    .where('expiryDate', '>', today)
    .orderBy('expiryDate', 'asc');
  const usedBatches = await db.runTransaction(async (tx) => {
    const itemSnap = await tx.get(itemRef);
    if (!itemSnap.exists) throw new HttpsError('not-found', 'Medicine record not found.');
    if ((itemSnap.data().onHand || 0) < quantity) {
      throw new HttpsError('failed-precondition', 'Insufficient stock.');
    }
    const batchSnap = await tx.get(batchesQuery);
    let remaining = quantity;
    const allocations = [];
    for (const batch of batchSnap.docs) {
      if (remaining === 0) break;
      const data = batch.data();
      if (data.expiryDate <= today || data.quantityAvailable <= 0) continue;
      const take = Math.min(remaining, data.quantityAvailable);
      allocations.push({ ref: batch.ref, next: data.quantityAvailable - take, batchNumber: data.batchNumber, quantity: take });
      remaining -= take;
    }
    if (remaining > 0) throw new HttpsError('failed-precondition', 'Not enough unexpired stock is available.');
    for (const allocation of allocations) {
      tx.update(allocation.ref, { quantityAvailable: allocation.next, updatedAt: FieldValue.serverTimestamp() });
    }
    tx.update(itemRef, { onHand: itemSnap.data().onHand - quantity, updatedAt: FieldValue.serverTimestamp() });
    return allocations.map(({ batchNumber, quantity: taken }) => ({ batchNumber, quantity: taken }));
  });
  await writeAudit(uid, 'inventory.stock_dispensed', 'medicine', medicineId, { quantity, batches: usedBatches });
  return { success: true, batches: usedBatches };
});

export const setUserRole = onCall({ region: REGION }, async (request) => {
  const { uid } = requireRole(request, ['dataController']);
  const email = cleanString(request.data?.email, 'User email', 254).toLowerCase();
  const role = cleanString(request.data?.role, 'Role', 30);
  if (!ROLES.has(role)) throw new HttpsError('invalid-argument', 'Unsupported role.');
  let target;
  try {
    target = await getAuth().getUserByEmail(email);
  } catch {
    throw new HttpsError('not-found', 'Create the staff account in Firebase Authentication first.');
  }
  if (target.uid === uid && role !== 'dataController') {
    throw new HttpsError('failed-precondition', 'You cannot remove your own Data Controller role through this function.');
  }
  await getAuth().setCustomUserClaims(target.uid, { ...(target.customClaims || {}), role });
  await db.collection('users').doc(target.uid).set({
    email, role, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid
  }, { merge: true });
  await writeAudit(uid, 'user.role_assigned', 'user', target.uid, { role });
  return { success: true };
});
