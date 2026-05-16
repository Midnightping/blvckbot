import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

// Google Drive Scopes
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

const getDriveClient = () => {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!email || !key) {
        console.warn('[DRIVE] Missing Google Service Account credentials. Cloud sync disabled.');
        return null;
    }

    const auth = new google.auth.JWT(email, null, key, SCOPES);
    return google.drive({ version: 'v3', auth });
};

// Helper to find or create a folder
const getOrCreateFolder = async (drive, name, parentId = null) => {
    try {
        const query = `name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${parentId ? ` and '${parentId}' in parents` : ''}`;
        const response = await drive.files.list({ q: query, fields: 'files(id, name)' });
        
        if (response.data.files && response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        const fileMetadata = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentId ? [parentId] : []
        };

        const folder = await drive.files.create({
            resource: fileMetadata,
            fields: 'id'
        });
        return folder.data.id;
    } catch (err) {
        console.error(`[DRIVE] Error getting/creating folder ${name}:`, err.message);
        return null;
    }
};

export const syncAllUsersToDrive = async () => {
    const drive = getDriveClient();
    if (!drive) return;

    const parentId = process.env.GOOGLE_DRIVE_PARENT_ID;
    if (!parentId) {
        console.warn('[DRIVE] GOOGLE_DRIVE_PARENT_ID is missing. Sync aborted.');
        return;
    }

    console.log('[DRIVE] Starting hourly cloud sync...');

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

        // User folder name: userId (which is already name + number usually)
        // Or we can try to find better info from bot_state.json
        const userFolderId = await getOrCreateFolder(drive, userId, parentId);
        if (!userFolderId) continue;

        console.log(`[DRIVE] Syncing ${files.length} files for user: ${userId}`);

        for (const file of files) {
            const filePath = path.join(viewOnceDir, file);
            
            try {
                const fileMetadata = {
                    name: file,
                    parents: [userFolderId]
                };
                const media = {
                    body: fs.createReadStream(filePath)
                };

                await drive.files.create({
                    resource: fileMetadata,
                    media: media,
                    fields: 'id'
                });

                // Delete local file after successful upload
                fs.unlinkSync(filePath);
            } catch (err) {
                console.error(`[DRIVE] Failed to upload ${file}:`, err.message);
            }
        }
    }

    console.log('[DRIVE] Hourly cloud sync completed.');
};
