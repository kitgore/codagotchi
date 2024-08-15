import axios from 'axios';
import * as vscode from 'vscode';
import { merge } from 'lodash';
import { CacheManager } from './cacheManager';
import { firebaseConfig, getFirebaseDatabase } from './firebaseInit';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';
import { ref, set, onValue, off } from 'firebase/database';
import { generateState, generateOAuthURL, BASE_URL } from './config';

export async function signInWithCustomTokenViaREST(customToken: string, context: vscode.ExtensionContext) {
    const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseConfig.apiKey}`;
    try {
        const response = await axios.post(signInUrl, {
            token: customToken,
            returnSecureToken: true,
        });
        const { idToken, refreshToken } = response.data;
        await context.secrets.store('refreshToken', refreshToken);
        return { idToken, refreshToken };
    } catch (error) {
        console.error('Error signing in with custom token:', error);
        throw error;
    }
}

export function initiateOAuthProcess(): { oauthUrl: string; state: string } {
    const state = generateState();
    const oauthUrl = generateOAuthURL(state);
    return { oauthUrl, state };
}

export async function listenForAuthToken(state: string): Promise<{ token: string; githubUsername: string }> {
    const database = getFirebaseDatabase();
    const tokenRef = ref(database, 'authTokens/' + state);

    return new Promise((resolve, reject) => {
        const tokenListener = onValue(
            tokenRef,
            (snapshot) => {
                const data = snapshot.val();
                if (data && data.status === 'ready') {
                    off(tokenRef, 'value', tokenListener);
                    resolve({ token: data.token, githubUsername: data.githubUsername });
                }
            },
            (error) => {
                off(tokenRef, 'value', tokenListener);
                reject(error);
            },
        );
    });
}

export async function completeAuthProcess(state: string, userId: string): Promise<void> {
    const database = getFirebaseDatabase();
    const authRef = ref(database, `authTokens/${state}`);
    await set(authRef, { status: 'complete' });
}

export async function signInWithFirebase(firebaseToken: string): Promise<string> {
    const auth = getAuth();
    try {
        const userCredential = await signInWithCustomToken(auth, firebaseToken);
        return userCredential.user.uid;
    } catch (error) {
        console.error('Firebase signInWithCustomToken error:', error);
        throw error;
    }
}

export async function logout(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete('refreshToken');
    await context.secrets.delete('idToken');
    await context.secrets.delete('userId');

    const auth = getAuth();
    await signOut(auth);

    // Clear any other stored data if necessary
    // For example, if you're using the globalState to store user data:
    await context.globalState.update('userInfo', undefined);

    console.log('User logged out successfully');
}

export async function refreshToken(refreshToken: string, context: vscode.ExtensionContext) {
    const refreshTokenUrl = `https://securetoken.googleapis.com/v1/token?key=${firebaseConfig.apiKey}`;
    try {
        const response = await axios.post(refreshTokenUrl, {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        });
        const { id_token, refresh_token } = response.data;
        await context.secrets.store('refreshToken', refresh_token);
        await context.secrets.store('idToken', id_token);
        return { idToken: id_token, refreshToken: refresh_token };
    } catch (error) {
        console.error('Error refreshing token:', error);
        throw error;
    }
}

export async function sendFriendRequest(context: vscode.ExtensionContext, recipientUsername: string) {
    const idToken = await context.secrets.get('idToken');
    try {
        const response = await axios.post(
            `${BASE_URL}/sendFriendRequest`,
            { recipientUsername },
            {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        console.log('Friend Request Sent');
        return response.data.message;
    } catch (error) {
        console.error('Error sending friend request:', error);
        throw error;
    }
}

export async function handleFriendRequest(context: vscode.ExtensionContext, requestId: string, action: string) {
    const idToken = await context.secrets.get('idToken');
    try {
        const response = await axios.post(
            `${BASE_URL}/handleFriendRequest`,
            { requestId, action },
            {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        return response.data.message;
    } catch (error) {
        console.error('Error handling friend request:', error);
        throw error;
    }
}

// TODO: add a timeout to the request (function can only call every 5 minutes)
export async function retrieveInbox(context: vscode.ExtensionContext, cacheManager: CacheManager) {
    const cacheKey = 'userInbox';
    const lastFetchTimestamp = (await cacheManager.getTimestamp(cacheKey)) || 0;
    const cachedInbox = (await cacheManager.get(cacheKey)) || {};

    //console.log(cachedInbox);

    const lengths = {} as { [key: string]: number };
    for (const key in cachedInbox) {
        if (typeof cachedInbox[key] === 'object') {
            lengths[key] = Object.keys(cachedInbox[key] || {}).length;
        }
    }

    const idToken = await context.secrets.get('idToken');
    try {
        const response = await axios.get(`${BASE_URL}/retrieveInbox`, {
            headers: {
                Authorization: `Bearer ${idToken}`,
                'Content-Type': 'application/json',
            },
            params: {
                timestamp: lastFetchTimestamp,
                ...lengths,
            },
        });

        const { flag, inboxData, timestamp: currentTimestamp } = response.data;

        let updatedInbox = flag === 'merge' ? merge({}, cachedInbox, inboxData) : inboxData;

        flag === 'merge' ? console.log('Inbox Merged') : console.log('Inbox Replaced');

        await cacheManager.set(cacheKey, {
            data: updatedInbox,
            timestamp: currentTimestamp,
        });

        return { updatedInbox, flag };
    } catch (error) {
        console.error('Error retrieving inbox:', error);
        throw error;
    }
}

export async function sendPostcard(context: vscode.ExtensionContext, recipientUsername: string, postcardJSON: JSON) {
    const idToken = await context.secrets.get('idToken');
    try {
        const response = await axios.post(
            `${BASE_URL}/sendPostcard`,
            { recipientUsername, postcardJSON },
            {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        console.log('Postcard Sent');
        return response.data.message;
    } catch (error) {
        console.error('Error sending postcard:', error);
        throw error;
    }
}

export async function retrieveInventory(context: vscode.ExtensionContext, cacheManager: CacheManager) {
    const cacheKey = 'userInventory';
    const lastFetchTimestamp = (await cacheManager.getTimestamp(cacheKey)) || 0;
    const cachedInventory = (await cacheManager.get(cacheKey)) || {};

    const totalItems = Object.keys(cachedInventory).length;

    const idToken = await context.secrets.get('idToken');
    try {
        const response = await axios.get(`${BASE_URL}/retrieveInventory`, {
            headers: {
                Authorization: `Bearer ${idToken}`,
                'Content-Type': 'application/json',
            },
            params: {
                timestamp: lastFetchTimestamp,
                totalItems: totalItems,
            },
        });

        const { flag, inventoryData, timestamp: currentTimestamp } = response.data;

        let updatedInventory = flag === 'merge' ? merge({}, cachedInventory, inventoryData) : inventoryData;

        flag === 'merge' ? console.log('Inventory Merged') : console.log('Inventory Replaced');

        await cacheManager.set(cacheKey, {
            data: updatedInventory,
            timestamp: currentTimestamp,
        });

        return { updatedInventory, flag };
    } catch (error) {
        console.error('Error retrieving inventory:', error);
        throw error;
    }
}

// TEST the TYPES
export async function syncUserData(context: vscode.ExtensionContext, userData: { inventoryUpdates: JSON; petUpdates: JSON; customizationUpdates: JSON }) {
    const idToken = await context.secrets.get('idToken');
    const { inventoryUpdates, petUpdates, customizationUpdates } = userData;
    try {
        const response = await axios.post(
            `${BASE_URL}/syncUserData`,
            { inventoryUpdates, petUpdates, customizationUpdates },
            {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        console.log('User Data Synced');
        return response.data.message;
    } catch (error) {
        console.error('Error syncing user data:', error);
        throw error;
    }
}
