import * as vscode from 'vscode';
import { getScheduler } from './scheduler';
import { JobQueueProvider } from './jobs';
import { FavoriteJobScriptProvider, JobScriptFavorites, JobScriptProvider } from './jobscripts';

export function activate(context: vscode.ExtensionContext): vscode.ExtensionContext {
    let scheduler = getScheduler();

    new JobQueueProvider(scheduler).register(context);
    const favorites = new JobScriptFavorites(context.workspaceState);
    new JobScriptProvider(scheduler, favorites).register(context);
    new FavoriteJobScriptProvider(favorites).register(context);

    return context;
}

export function deactivate() {}
