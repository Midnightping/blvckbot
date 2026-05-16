import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';
import path from 'path';

// Configure Cloudinary
const configureCloudinary = () => {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
        console.warn('[CLOUDINARY] Missing credentials. Cloud sync disabled.');
        return false;
    }

    cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true
    });
    return true;
};

export const syncUserToCloudinary = async (userId) => {
    if (!configureCloudinary()) return { success: false, error: 'Cloudinary not configured' };

    const railwayVolume = '/data/sessions';
    const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');
    const userPath = path.join(sessionsRoot, userId);

    if (!fs.existsSync(userPath)) return { success: false, error: 'User directory not found' };

    const viewOnceDir = path.join(userPath, 'viewonce_media');
    if (!fs.existsSync(viewOnceDir)) return { success: true, count: 0 };

    const files = fs.readdirSync(viewOnceDir);
    if (files.length === 0) return { success: true, count: 0 };

    let successCount = 0;
    for (const file of files) {
        const filePath = path.join(viewOnceDir, file);
        const extension = path.extname(file).toLowerCase();
        let resourceType = 'image';
        if (extension === '.mp4' || extension === '.avi' || extension === '.mov') resourceType = 'video';
        if (extension === '.mp3' || extension === '.ogg' || extension === '.wav') resourceType = 'raw';

        try {
            await cloudinary.uploader.upload(filePath, {
                folder: `BlvckBot/${userId}`,
                public_id: path.parse(file).name,
                resource_type: resourceType === 'raw' ? 'auto' : resourceType
            });
            fs.unlinkSync(filePath);
            successCount++;
        } catch (err) {
            console.error(`[CLOUDINARY] Failed to upload ${file}:`, err.message);
        }
    }

    return { success: true, count: successCount };
};

export const syncAllUsersToCloudinary = async () => {
    if (!configureCloudinary()) return;

    console.log('[CLOUDINARY] Starting hourly cloud sync...');

    const railwayVolume = '/data/sessions';
    const sessionsRoot = fs.existsSync('/data') ? railwayVolume : path.join(process.cwd(), 'sessions');

    if (!fs.existsSync(sessionsRoot)) return;

    const userFolders = fs.readdirSync(sessionsRoot);

    for (const userId of userFolders) {
        const userPath = path.join(sessionsRoot, userId);
        if (!fs.statSync(userPath).isDirectory()) continue;

        const viewOnceDir = path.join(userPath, 'viewonce_media');
        if (!fs.existsSync(viewOnceDir)) continue;

        const files = fs.readdirSync(viewOnceDir);
        if (files.length === 0) continue;

        console.log(`[CLOUDINARY] Syncing ${files.length} files for user: ${userId}`);

        for (const file of files) {
            const filePath = path.join(viewOnceDir, file);
            const extension = path.extname(file).toLowerCase();
            
            // Determine resource type
            let resourceType = 'image';
            if (extension === '.mp4' || extension === '.avi' || extension === '.mov') resourceType = 'video';
            if (extension === '.mp3' || extension === '.ogg' || extension === '.wav') resourceType = 'raw'; // audio/voice notes

            try {
                await cloudinary.uploader.upload(filePath, {
                    folder: `BlvckBot/${userId}`, // Isolated user folders
                    public_id: path.parse(file).name,
                    resource_type: resourceType === 'raw' ? 'auto' : resourceType
                });

                // Delete local file after successful upload
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error(`[CLOUDINARY] Failed to upload ${file}:`, err.message);
            }
        }
    }

    console.log('[CLOUDINARY] Hourly cloud sync completed.');
};
