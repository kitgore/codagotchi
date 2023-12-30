import * as vscode from 'vscode';
import { getNonce } from './getNonce';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid'; // Ensure you have the 'uuid' package installed.
import { database } from './firebaseInit';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getDatabase, ref, set, get, onValue } from 'firebase/database';

const CLIENT_ID = 'a253a1599d7b631b091a';
const REDIRECT_URI = encodeURIComponent('https://us-central1-codagotchi.cloudfunctions.net/handleGitHubRedirect');
const REQUESTED_SCOPES = 'user,read:user';
let githubUsername = '';

// Generate a unique state value
const state = uuidv4();

const O_AUTH_URL = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=${REQUESTED_SCOPES}&state=${state}`;

function printJsonObject(jsonObject: { [key: string]: any }): void {
    for (const key in jsonObject) {
        if (jsonObject.hasOwnProperty(key)) {
            console.log(`Key: ${key}, Value: ${jsonObject[key]}`);
        }
    }
}

function setCurrentState(context: vscode.ExtensionContext, partialUpdate: { [key: string]: any }): Thenable<void> {
    // Retrieve the existing global state
    const currentGlobalState = context.globalState.get<{ [key: string]: any }>('globalInfo', {});

    // Merge the partial update with the existing state
    const updatedGlobalState = { ...currentGlobalState, ...partialUpdate };

    // Update the global state with the merged result
    return context.globalState.update('globalInfo', updatedGlobalState);
}

function getCurrentState(context: vscode.ExtensionContext): { [key: string]: any } {
    // Retrieve and return the global state
    return context.globalState.get<{ [key: string]: any }>('globalInfo', {});
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;
    _doc?: vscode.TextDocument;

    private _onDidViewReady: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidViewReady: vscode.Event<void> = this._onDidViewReady.event;

    private webviewImageUris: { [key: string]: string } = {}; // Store the image URIs

    private context: vscode.ExtensionContext;

    constructor(private readonly _extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.context = context; }

    private getImageUris(): { [key: string]: vscode.Uri } {
        const imageDir = path.join(this._extensionUri.fsPath, 'images');
        const imageNames = fs.readdirSync(imageDir);
        const uris: { [key: string]: vscode.Uri } = {};

        for (const imageName of imageNames) {
            const uri = vscode.Uri.file(path.join(imageDir, imageName));
            uris[imageName] = uri;
        }

        // Convert the URIs using webview.asWebviewUri
        for (const key in uris) {
            this.webviewImageUris[key] = this._view?.webview.asWebviewUri(uris[key]).toString() || '';
        }

        return uris;
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        // Store the state value temporarily in globalState
        vscode.commands.executeCommand('setContext', 'oauthState', state);

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,

            // Include the folder containing the images in localResourceRoots
            localResourceRoots: [
                vscode.Uri.file(path.join(this._extensionUri.fsPath, 'images')),
                vscode.Uri.file(path.join(this._extensionUri.fsPath, 'media')),
                vscode.Uri.file(path.join(this._extensionUri.fsPath, 'out', 'compiled')),
            ],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        this._onDidViewReady.fire();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'webview-ready': {
                    // Convert the URIs using webview.asWebviewUri
                    const imageUris = this.getImageUris();
                    const webviewImageUris: { [key: string]: string } = {};
                    for (const key in imageUris) {
                        webviewImageUris[key] = webviewView.webview.asWebviewUri(imageUris[key]).toString();
                    }

                    // Send the converted URIs to the webview
                    webviewView.webview.postMessage({
                        type: 'image-uris',
                        uris: webviewImageUris,
                    });
                    break;
                }

                case 'getGlobalState': {
                    console.log("----Getting globalState----")
                    printJsonObject(getCurrentState(this.context))
                    this._view?.webview.postMessage({
                        type: 'currentState',
                        value: getCurrentState(this.context),
                    });
                    break;
                }

                case 'setGlobalState': {
                    console.log("****Setting globalState****")
                    // printJsonObject(data.value)
                    setCurrentState(this.context, data.value)
                    break;
                }

                case 'openOAuthURL': {
                    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(O_AUTH_URL));
                    console.log('openOAuthUrl');
                
                    const tokenRef = ref(database, 'authTokens/' + state);
                    onValue(tokenRef, (snapshot) => {
                        const data = snapshot.val();
                        if (data && data.status === 'ready') {
                            const firebaseToken = data.token;
                            githubUsername = data.githubUsername;
                            console.log('Received token:', firebaseToken);
                
                            // Automatically sign in with the received custom token
                            const auth = getAuth();
                            signInWithCustomToken(auth, firebaseToken)
                            .then((userCredential) => {
                                // User is now authenticated with Firebase
                                const uid = userCredential.user.uid;
                                
                                // Reference to the user's data in the database
                                const db = getDatabase();
                                const userRef = ref(db, 'users/' + uid);
                        
                                // Check if the user's data exists
                                get(userRef).then((snapshot) => {
                                    if (!snapshot.exists()) {
                                        // If the user's data doesn't exist, create it
                                        set(userRef, {
                                            // Initialize user data, e.g., 
                                            createdAt: new Date().toISOString(),
                                            githubUsername: githubUsername
                                            // ... other initial data
                                        }).then(() => {
                                            console.log('User data initialized.');
                                            // Send the GitHub username to the webview
                                            webviewView.webview.postMessage({
                                                type: 'github-username',
                                                username: githubUsername,
                                            });
                                        }).catch((error) => {
                                            console.error('Error initializing user data:', error);
                                        });
                                    }
                                }).catch((error) => {
                                    console.error('Error checking user data:', error);
                                });
                        
                            })
                            .catch((error) => {
                                // Handle errors
                                console.error('Error signing in with custom token:', error);
                            });
                        }
                    });
                
                    break;
                }

                case 'onInfo': {
                    if (!data.value) {
                        return;
                    }
                    vscode.window.showInformationMessage(data.value);
                    break;
                }
                case 'onError': {
                    if (!data.value) {
                        return;
                    }
                    vscode.window.showErrorMessage(data.value);
                    break;
                }
                case 'resize': {
                    const width = data.width;
                    const height = data.height;

                    // Now you have the dimensions of the WebView
                    console.log(`WebView dimensions: ${width}x${height}`);
                    break;
                }
            }
        });
    }

    public revive(panel: vscode.WebviewView) {
        this._view = panel;
    }

    public setCurrentRoom(roomName: string) {
        this._view?.webview.postMessage({
            type: 'currentRoom',
            value: roomName,
        });
    }

    public getGithubUsername() {
        return githubUsername;
    }

    // private handleOAuthCallback(state: string, code: string) {
    //     if (state !== this.currentIdentifier) {
    //         console.error("State does not match! Possible CSRF attack.");
    //         return;
    //     }
    //     // Continue with the OAuth process using the provided code
    // }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
        const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'codagotchi.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'out/compiled', 'sidebar.js'));

        // Use a nonce to only allow a specific script to be run.
        const nonce = getNonce();

        return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="img-src vscode-webview-resource: https: data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <link href="${styleResetUri}" rel="stylesheet">
        <link href="${styleVSCodeUri}" rel="stylesheet">
        
        <script nonce="${nonce}">
        
        const tsvscode = acquireVsCodeApi();

        window.addEventListener('resize', () => {
          const width = window.innerWidth;
          const height = window.innerHeight;
          
          // Send a message to the extension
          tsvscode.postMessage({
            type: 'resize',
            width: width,
            height: height
          });
        });
        
        window.addEventListener('click', (event) => {
          const x = event.clientX;
          const y = event.clientY;
          
          // Send a message to the extension with the click coordinates
          tsvscode.postMessage({
            type: 'click',
            x: x,
            y: y
          });
        });
        
        // Trigger the resize event manually to get initial dimensions
        window.dispatchEvent(new Event('resize'));
        </script>
        </head>
        <body>
        <!--
        <button 
            id="github-login" 
            style="padding: 3px; border-radius: 3px; background-color: #4f4f4f; transition: background-color 0.2s; cursor: pointer; color: #c9c9c9;"
            onmouseover="this.style.backgroundColor='#999797';"
            onmousedown="this.style.backgroundColor='#333';" 
            onmouseup="this.style.backgroundColor='#4f4f4f';" 
            onmouseout="this.style.backgroundColor='#4f4f4f';"
        >
            Login with GitHub
        </button>
        -->

        <script nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>`;
    }
}
