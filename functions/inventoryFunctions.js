import { verifyToken } from './verifyToken.js';
import * as functions from 'firebase-functions';
import { admin } from './firebaseConfig.js';

/*
 A function to periodically sync the user's inventory with the database.
 The function timeout is handled by the client. The client will call this function every ? minutes. 
    @param {Object} userRef - The user reference in the database
    @param [{Object}] inventoryUpdates - The inventory updates to be synced from the client
*/

// What could be the updates:
// 1. Adding / Removing / Transaction with items
// 1.1. Adding / Removing / Transaction with currencies (a part of the inventory field, so handled the same as items)
// 2. Owned customization items (like backgrounds or pets, etc.) - these are not part of the inventory field, so they need to be handled separately
// 2.1 Update user customization (bedroom updates) - setting the user's customization data
// 3. Pet updates (hunger, happiness, clothing, etc.) - setting the user's pet data
// 4. XP updates - updating the user's XP

async function processAllUpdates(uid, inventoryUpdates, petUpdates, customizationUpdates) {
    const updates = {};

    // Process inventory updates
    if (inventoryUpdates && inventoryUpdates.length > 0) {
        const inventoryChanges = {};
        let xpChange = 0;

        for (const update of inventoryUpdates) {
            if (Array.isArray(update.items)) {
                for (const item of update.items) {
                    inventoryChanges[item.id] = (inventoryChanges[item.id] || 0) + item.amount;
                }
            } else if (update.itemId) {
                inventoryChanges[update.itemId] = (inventoryChanges[update.itemId] || 0) + update.amount;
            }

            if (update.xp) {
                xpChange += update.xp;
            }
        }

        // Apply inventory changes
        for (const [itemId, amount] of Object.entries(inventoryChanges)) {
            updates[`/users/${uid}/protected/inventory/${itemId}`] = admin.database.ServerValue.increment(amount);
        }

        // Apply XP change
        if (xpChange !== 0) {
            updates[`/users/${uid}/protected/xp`] = admin.database.ServerValue.increment(xpChange);
        }
    }

    // Process pet updates
    if (petUpdates) {
        for (const [key, value] of Object.entries(petUpdates)) {
            updates[`/users/${uid}/protected/pet/${key}`] = value;
        }
    }

    // Process customization updates
    if (customizationUpdates) {
        for (const [key, value] of Object.entries(customizationUpdates)) {
            updates[`/users/${uid}/protected/owned/${key}`] = value;
        }
    }

    // Perform the update if there are any changes
    if (Object.keys(updates).length > 0) {
        try {
            await admin.database().ref().update(updates);
        } catch (error) {
            console.error('Error updating user data:', error);
            throw new Error('Failed to update user data');
        }
    }
}


/*
    Sync user data with the database.
    The client will call this function to sync the user's data with the database.
    The function will receive the user's data and update the database accordingly.
    The function will return a success message if the update is successful.
    Example of req.body:

            {
        "inventoryUpdates": [
            {"items": 
            [{"id": "item1", "amount": 5}, {"id": "item2", "amount": -2}], "xp": 100},
            {"itemId": "item3", "amount": 1, "xp": 50}
        ],
        "petUpdates": {
            "hunger": 80,
            "happiness": 90,
            "currentPetXp": 100
        },
        "customizationUpdates": {
            "background": "forest",
            "pet_clothing": "hat_001"
        }
        }
*/

export const syncUserData = functions.https.onRequest((req, res) => {
    if (req.method !== 'POST') {
        return res.status(403).send({ success: false, message: 'Forbidden! Only POST requests are allowed.' });
    }

    verifyToken(req, res, async () => {
        try {
            // console.log("req user:", req.user);
            const uid = req.user.uid;
            const { inventoryUpdates, petUpdates, customizationUpdates } = req.body;

            // Process all updates
            await processAllUpdates(uid, inventoryUpdates, petUpdates, customizationUpdates);

            res.status(200).send({ success: true, message: 'User data synced successfully' });
            
        } catch (error) {
            console.error('Sync user data error:', error);
            res.status(500).send({ success: false, message: 'An error occurred while syncing user data' });
        }
    });
});

export const retrieveInventory = functions.https.onRequest(async (req, res) => {
    if (req.method !== 'GET') {
        return res.status(403).send({ success: false, message: 'Forbidden! Only GET requests are allowed.' });
    }

    verifyToken(req, res, async () => {
        const uid = req.user.uid;

        const inventoryRef = admin.database().ref(`users/${uid}/protected/inventory`);
        try {
            const inventorySnapshot = await inventoryRef.once('value');
            const inventoryData = inventorySnapshot.val() || {};

            const { timestamp, totalItems } = req.query;
            const lastFetchTime = parseInt(timestamp || 0);
            const clientTotalItems = parseInt(totalItems || 0);

            let flag = 'merge';
            let responseData = {};

            const serverTotalItems = Object.keys(inventoryData).length;

            console.log(`Server Total Items: ${serverTotalItems}, Client Total Items: ${clientTotalItems}`);

            if (serverTotalItems !== clientTotalItems) {
                console.log('Mismatch detected in total items. Needs full replace.');
                flag = 'replace';
                responseData = inventoryData;
            } else {
                // Check for new or updated items
                const newOrUpdatedItems = Object.entries(inventoryData).filter(([_, item]) => {
                    return item.lastUpdated && item.lastUpdated > lastFetchTime;
                });

                responseData = Object.fromEntries(newOrUpdatedItems);
            }

            const currentTimestamp = Date.now();

            res.status(200).send({
                success: true,
                flag: flag,
                inventoryData: responseData,
                timestamp: currentTimestamp,
            });
        } catch (error) {
            console.error('Failed to retrieve inventory:', error);
            res.status(500).send({ success: false, message: 'Failed to retrieve inventory' });
        }
    });
});
