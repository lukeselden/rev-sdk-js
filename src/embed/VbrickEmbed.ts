import { EventBus } from './EventBus';
import { VbrickEmbedConfig } from './VbrickEmbedConfig';
import { getLogger, ILogger } from '../Log';
import { IVbrickBaseEmbed, PlayerStatus } from './IVbrickApi';
import { TokenType, VbrickSDKToken } from '../VbrickSDK';
import { TVbrickEvent, IListener } from './IVbrickEvents';
import { IBasicInfo, ISubtitles } from './IVbrickTypes';

/**
 * Base class for embedded content.
 */
export abstract class VbrickEmbed<TInfo extends IBasicInfo> implements IVbrickBaseEmbed<TInfo> {

	/**
	* video playing, buffering, etc
	*/
	public get playerStatus(): PlayerStatus {
		return this._playerStatus;
	}
	private _playerStatus = PlayerStatus.Initializing;

	/**
	* Player Volume. 0-1
	*/
	public get volume(): number {
		return this._volume;
	}
	private _volume: number;

	/**
	 * Whether subtitles are enabled, and selected language
	 */
	public get currentSubtitles(): ISubtitles {
		return this._currentSubtitles;
	}
	private _currentSubtitles: ISubtitles = { enabled: false };

	public get isLive(): boolean {
		return this.info?.isLive;
	}
	
	public get info(): TInfo {
		return this._info;
	}
	private _info?: TInfo;

	protected iframe: HTMLIFrameElement;
	protected readonly iframeUrl: string;
	protected eventBus: EventBus;
	private init: Promise<any>;
	private unsubscribes: Array<() => void>;
	protected logger: ILogger;

	constructor(
		id: string,
		protected readonly config: VbrickEmbedConfig,
		protected readonly container: HTMLElement
	) {
		this.iframeUrl = this.getEmbedUrl(id, this.config);
		this.logger = getLogger(this.config);
	}

	/**
	 * Plays the video if it is paused.
	 */
	 public play(): void {
		this.eventBus.publish('playVideo');
	}
	/**
	  * Pauses the video if it is playing.
	  */
	public pause(): void {
		this.eventBus.publish('pauseVideo');
	}

	/**
	 * Sets player volume
	 * @param volume {number} 0-1
	 */
	public setVolume(volume: number): void {
		this.eventBus.publish('setVolume', { volume });
	}

	/**
	 * update the current subtitles settings
	 * @param subtitles enable/disable subtitles and set language (leave language blank to use closed captions encoded into video stream)
	 */
	public setSubtitles(subtitles: ISubtitles) {
		this.eventBus.publish('setSubtitles', subtitles);
	}

	/**
	 * Indicates the embedded content was initialized and authenticated.
	 * If there was a problem loading the content, or a problem with the token, the promise will be rejected.
	 */
	public initialize(): Promise<void> {
		if (this.init) {
			return this.init;
		}
		this.iframe = this.render();
		this.eventBus = new EventBus(this.iframe, this.config);
		this.initializeEmbed();

		const timeout = (this.config.timeoutSeconds * 1000) || undefined;

		return this.init = Promise.all([
			this.initializeToken(),
			this.eventBus.awaitEvent('load', 'error', timeout)
		])
			.then(([token]) => {
				this.logger.log('embed loaded, authenticating');
				this.eventBus.publish('authenticated', { token });
				this.eventBus.awaitEvent('authChanged', 'error', timeout);
			})
			.catch(err => {
				this._playerStatus = PlayerStatus.Error;
				this.logger.error('Embed initialization error: ', err);
				this.eventBus.publishError('initializationFailed');
				this.eventBus.emitLocalError('Error loading embed content', err);
				return Promise.reject(err);
			});
	}

	protected initializeToken(): Promise<any> {
		if (!this.config.token) {
			return Promise.resolve()
		}

		if (this.config.token.type !== TokenType.ACCESS_TOKEN) {
			return Promise.reject('Unsupported token type');
		}

		return Promise.resolve({
			accessToken: this.config.token.value
		});
	}
	protected initializeEmbed(): void {
		this.eventBus.on('videoLoaded', (e: any) => {
			this._info = e;
			this._playerStatus = PlayerStatus.Paused;
		});
		//don't include status in information, since it can change
		this.eventBus.on('webcastLoaded', ({status, ...info}: any) => {
			this._info = info;
		});
		
		this.eventBus.on('playerStatusChanged', e => this._playerStatus = e.status);
		this.eventBus.on('subtitlesChanged', subtitles => {
			this._currentSubtitles = subtitles;
		});
	}
	protected abstract getEmbedUrl(id: string, config: VbrickEmbedConfig);
	
	public on<T extends TVbrickEvent>(event: T, listener: IListener<T>): void {
		//ensure internal updates take effect before calling client handlers
		this.eventBus.on<any>(event, (e: any) => setTimeout(() => listener(e)));
	}

	public off<T extends TVbrickEvent>(event: T, listener: IListener<T>): void {
		this.eventBus.off(event, listener);
	}

	private render(): HTMLIFrameElement {
		const iframe = document.createElement('iframe');
		iframe.setAttribute('frameborder', '0');
		iframe.setAttribute('allowFullScreen', '')
		iframe.allow = 'autoplay';
		iframe.width = this.config.width || '100%';
		iframe.height = this.config.height || '100%';
		iframe.src = this.iframeUrl;

		if (this.config.className) {
			iframe.className = this.config.className;
		}

		this.container.appendChild(iframe);

		return iframe;
	}

	public destroy(): void {
		this.iframe.remove();
		this.eventBus.destroy();
		this.init = null;
		this.unsubscribes?.forEach(fn => fn());
	}

	public async updateToken(newToken: VbrickSDKToken): Promise<void> {
		this.config.token = newToken;
		try {
			const token = await this.initializeToken();
			this.eventBus.publish('authChanged', { token });
			await this.eventBus.awaitEvent('authChanged', 'error');
		} catch (error) {
			this.logger.error('Error updating token: ', error);
			throw error;
		}
	}
}

/**
 * parses a config object and converts into query parameters for the iframe embed URL
 * @param config 
 */
 export function getEmbedQuery(config: VbrickEmbedConfig): Record<string, undefined | boolean | string> {
	return {
		tk: !!config.token,
		popupAuth: !config.token && (config.popupAuth ? 'true' : 'false'), //popupAuth requires a true value
		accent: config.accentColor,
		autoplay: config.autoplay,
		forceClosedCaptions: config.forcedCaptions,
		loopVideo: config.playInLoop,
		noCc: config.hideSubtitles,
		noCenterButtons: config.hideOverlayControls,
		noChapters: config.hideChapters,
		noFullscreen: config.hideFullscreen,
		noPlayBar: config.hidePlayControls,
		noSettings: config.hideSettings,
		startAt: config.startAt
	};
}
