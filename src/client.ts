import * as request from 'request';

import { CatalogClientGroup } from './client/catalog';
import { PrivateClientGroup } from './client/private';
import { StatsClientGroup } from './client/stats';
import { UserClientGroup } from './client/user';
import { OAuth, RefreshedToken } from './oauth';
import { EventEmitter } from 'events';
import * as Errors from './errors/http';

export class Client extends EventEmitter {

    /**
     * @internal
     */
    private _catalog : CatalogClientGroup;

    /**
     * @internal
     */
    private _private: PrivateClientGroup;

    /**
     * @internal
     */
    private _stats: StatsClientGroup;

    /**
     * @internal
     */
    private _user: UserClientGroup;

    /**
     * @internal
     */
    private options : ClientOptions;

    public constructor(token: string);
    public constructor(options: ClientOptions);
    public constructor(tokenOrOptions: ClientOptions | string) {
        super();

        if (typeof tokenOrOptions === 'string') {
            tokenOrOptions = { token: tokenOrOptions };
        }

        this.options = tokenOrOptions;
        this._catalog = new CatalogClientGroup(this);
        this._private = new PrivateClientGroup(this);
        this._stats = new StatsClientGroup(this);
        this._user = new UserClientGroup(this);
    }

    /**
     * The current access token for the client, which may either be an OAuth access token or a personal token.
     */
    public get token() {
        return this.options.token;
    }

    /**
     * The refresh token if one was provided when the client was instantiated. The refresh token is only applicable to
     * OAuth sessions and is used by the client to predict the expiration of access tokens for faster regeneration.
     *
     * If a refresh token is not known or available, this will be `undefined`.
     */
    public get refreshToken() {
        return this.options.refreshToken;
    }

    /**
     * The timestamp (in milliseconds) when the current token expires. This will be `undefined` if the client was not
     * instantiated with an expiration time.
     */
    public get expiration() {
        return this.options.expiration;
    }

    /**
     * This will be  `true` if this token has expired. This will always return `false` if the client was not
     * instantiated with an expiration time.
     */
    public get expired() {
        if (this.options.expiration) {
            return this.options.expiration < (new Date()).getTime();
        }

        return false;
    }

    /**
     * The number of milliseconds remaining until the current token expires. This can become negative if the expiration
     * time is in the past. If an expiration time is not set on the client, this will be `undefined`.
     */
    public get ttl() {
        if (!this.options.expiration) return;

        // Convert dates into second timestamps
        if (this.options.expiration instanceof Date) {
            this.options.expiration = this.options.expiration.getTime();
        }

        return this.options.expiration - (new Date()).getTime();
    }

    /**
     * Returns the identity of the current token, which includes the account id, a list of all granted permissions, and
     * the number of seconds until the token expires.
     */
    public getIdentity() {
        return this.get<IdentityResponse>('/whoami');
    }

    /**
     * A collection of endpoints for browsing the Envato Market catalog.
     */
    public get catalog() {
        return this._catalog;
    }

    /**
     * A collection of endpoints for accessing private details about the current user.
     */
    public get private() {
        return this._private;
    }

    /**
     * A collection of endpoints for accessing public details about users.
     */
    public get user() {
        return this._user;
    }

    /**
     * A collection of endpoints for retrieving general statistics about the marketplaces.
     */
    public get stats() {
        return this._stats;
    }

    /**
     * Sends a `GET` request to the given path on the API and returns the parsed response.
     *
     * @param path The path to query (such as `"/catalog/item"`).
     */
    public get<T = Object>(path: string) : Promise<T> {
        return this.fetch('GET', path);
    }

    /**
     * Sends a `POST` request to the given path on the API and returns the parsed response.
     *
     * @param path The path to query (such as `"/catalog/item"`).
     * @param params The posted parameters to send with the request.
     */
    public post<T = Object>(path: string, params?: { [name: string]: any }) : Promise<T> {
        return this.fetch('POST', path, params);
    }

    /**
     * Sends a `PUT` request to the given path on the API and returns the parsed response.
     *
     * @param path The path to query (such as `"/catalog/item"`).
     * @param params The posted parameters to send with the request.
     */
    public put<T = Object>(path: string, params?: { [name: string]: any }) : Promise<T> {
        return this.fetch('PUT', path, params);
    }

    /**
     * Sends a `PATCH` request to the given path on the API and returns the parsed response.
     *
     * @param path The path to query (such as `"/catalog/item"`).
     * @param params The posted parameters to send with the request.
     */
    public patch<T = Object>(path: string, params?: { [name: string]: any }) : Promise<T> {
        return this.fetch('PATCH', path, params);
    }

    /**
     * Sends a `DELETE` request to the given path on the API and returns the parsed response.
     *
     * @param path The path to query (such as `"/catalog/item"`).
     * @param params The posted parameters to send with the request.
     */
    public delete<T = Object>(path: string, params?: { [name: string]: any }) : Promise<T> {
        return this.fetch('DELETE', path, params);
    }

    /**
     * Fetches the path via the given method.
     * @internal
     */
    protected fetch<T>(method: string, path: string, form ?: { [name: string]: any }) : Promise<T> {
        return new Promise(async (resolve, reject) => {
            if (this.expired && this.options.oauth && this.options.refreshToken) {
                let refresh = await this.options.oauth.renew(this);

                this.options.token = refresh.token;
                this.options.expiration = refresh.expiration;

                this.emit('renew', refresh);
            }

            request(Object.assign({}, this.options.request || {}, {
                url: this.uri(path),
                headers: {
                    'Authorization': 'Bearer ' + this.options.token,
                    'User-Agent': this.options.userAgent || 'Envato.js (https://github.com/baileyherbert/envato.js)'
                },
                method,
                form
            }), (err, response, body) => this.handleResponse(err, response, body, resolve, reject));
        });
    }

    /**
     * Returns an absolute URL to the API with the given path.
     * @internal
     */
    private uri(path: string) {
        return 'https://api.envato.com/' + path.replace(/^\/+/, '');
    }

    /**
     * Handles a response from the API, properly throwing errors or parsing the response as appropriate.
     * @internal
     */
    private handleResponse(err: any, response: request.Response, body: any, resolve: Function, reject: Function) {
        this.emit('debug', err, response, body);

        if (err) return reject(err);
        if (response.statusCode !== 200) {
            switch (response.statusCode) {
                case 400: return reject(new Errors.BadRequestError(this.getErrorResponse(body)));
                case 401: return reject(new Errors.UnauthorizedError(this.getErrorResponse(body)));
                case 403: return reject(new Errors.AccessDeniedError(this.getErrorResponse(body)));
                case 404: return reject(new Errors.NotFoundError(this.getErrorResponse(body)));
                case 429: return reject(new Errors.TooManyRequestsError(this.getErrorResponse(body)));
                case 500: return reject(new Errors.ServerError(this.getErrorResponse(body)));
                default: return reject(new Errors.HttpError('Unknown error', response.statusCode, this.getErrorResponse(body)));
            }
        }

        try {
            return resolve(JSON.parse(body, (key, value) => {
                let date !: Date;

                if ((key.endsWith('_at') || key.endsWith('_until')) && value) date = new Date(value);
                else if ((key === 'month' || key === 'date') && value) date = new Date(value);

                if (date && date.toString() !== 'Invalid Date') return date;
                return value;
            }));
        }
        catch (error) {
            throw new Error(`Failed to parse response: ${error.message}`);
        }
    }

    /**
     * Returns an `ErrorResponse` instance from the given response body.
     * @internal
     */
    private getErrorResponse(body: any) : Errors.ErrorResponse | undefined {
        if (typeof body == 'string') {
            try {
                return JSON.parse(body);
            }
            catch (error) {
                return undefined;
            }
        }

        return {
            error: 'Unknown error'
        };
    }

    public on(event: 'debug', listener: (err: Error | undefined, response: request.Response, body: string) => void): this;
    public on(event: 'renew', listener: (data: RefreshedToken) => void): this;
    public on(event: string, listener: (...args: any[]) => void) {
        return super.on(event, listener);
    }
}

export type ClientOptions = {

    /**
     * The token to use for authorization. Acceptable values include:
     *
     * - Personal tokens.
     * - Access tokens (OAuth).
     */
    token : string;

    /**
     * The user agent string to send with requests. This should briefly explain what your app is or its purpose.
     * Please do not use a generic browser user agent.
     *
     * Here are some examples of good user agents:
     *
     * - `"License activation for my themes"`
     * - `"Support forum authentication & license verification"`
     * - `"Gathering data on items"`
     */
    userAgent ?: string;

    /**
     * For OAuth sessions, you may optionally provide the refresh token to enable automatic token renewal when the
     * current access token expires. You must also supply the `expiration` option when providing this option.
     */
    refreshToken ?: string;

    /**
     * For OAuth sessions, you should provide a timestamp representing the time when the access token expires as a
     * number (in milliseconds) or a `Date`. The client will automatically generate a new access token using the
     * `refreshToken` option after the expiration time is reached, as long as the `oauth` option is provided.
     *
     * **Note:** If you need to store newly generated access tokens, listen for the `renew` event on the client.
     */
    expiration ?: Date | number;

    /**
     * The OAuth helper instance to use for automatically refreshing access tokens.
     */
    oauth ?: OAuth;

    /**
     * Optional configuration for the underlying `request` library.
     */
    request ?: request.CoreOptions;

};

export type IdentityResponse = {
    /**
     * The client ID of the application, if this is an OAuth session. Otherwise, this is `null`.
     */
    clientId ?: string;

    /**
     * The unique ID of the user who is authorized by the current token.
     */
    userId: number;

    /**
     * A list of permissions (scopes) the current token has been granted.
     */
    scopes: string[];

    /**
     * The number of seconds remaining until the current token expires. This will always be `315360000` for personal
     * tokens as they are indefinitely valid.
     */
    ttl: number;
};
