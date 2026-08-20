export const APP_LOCALES = ["zh-Hans", "en"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];
export type AppLocalePreference = "auto" | AppLocale;

export interface AppLanguageSettings {
  readonly preference: AppLocalePreference;
  setPreference(preference: AppLocalePreference): void;
}
export type TextDirection = "ltr" | "rtl";
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export type PluralMessages = Readonly<
  { other: string }
  & Partial<Record<Exclude<PluralCategory, "other">, string>>
>;

export interface AppMessages {
  readonly common: {
    readonly appName: string;
    readonly unknown: string;
    readonly unavailable: string;
    readonly actions: {
      readonly cancel: string;
      readonly close: string;
      readonly continue: string;
      readonly delete: string;
      readonly done: string;
      readonly retry: string;
      readonly save: string;
    };
    readonly units: {
      readonly items: PluralMessages;
      readonly seconds: PluralMessages;
      readonly hours: PluralMessages;
      readonly days: PluralMessages;
    };
  };
  readonly shell: {
    readonly nameInputLabel: string;
    readonly openTeti: string;
    readonly openPendingTasks: PluralMessages;
    readonly openPendingConnections: PluralMessages;
  };
  readonly firstLaunch: {
    readonly booting: {
      readonly message: string;
      readonly progress: string;
    };
    readonly welcome: {
      readonly title: string;
      readonly message: string;
      readonly action: string;
    };
    readonly naming: {
      readonly title: string;
      readonly message: string;
      readonly action: string;
      readonly placeholder: string;
    };
    readonly creating: {
      readonly title: string;
      readonly phases: Record<
        "preparing" | "provisioning_chatmail" | "persisting_account"
          | "registering_identity" | "verifying_account" | "finalizing",
        { readonly label: string; readonly message: string }
      >;
    };
    readonly ready: {
      readonly message: string;
      readonly action: string;
      readonly progress: string;
    };
    readonly idleMessage: string;
    readonly recoverable: {
      readonly title: string;
      readonly titleWithCode: string;
      readonly retryAction: string;
      readonly retryConnectionAction: string;
    };
    readonly fatalTitle: string;
    readonly validation: {
      readonly empty: string;
      readonly tooLong: string;
      readonly controlCharacter: string;
      readonly generic: string;
    };
    readonly errors: {
      readonly temporaryAccountLoad: string;
      readonly corruptAccount: string;
      readonly partialAccount: string;
      readonly chatmailProvisioning: string;
      readonly localPersistence: string;
      readonly networkIdentity: string;
      readonly loadedAccountVerification: string;
      readonly runtimeStartup: string;
      readonly internalState: string;
      readonly unknown: string;
    };
  };
  readonly updateBlocker: {
    readonly title: string;
    readonly message: string;
    readonly status: string;
    readonly unknownMinimumVersion: string;
  };
  readonly toolbar: {
    readonly aiPassport: string;
    readonly aiPassportUnavailable: string;
    readonly passportSharingEnabled: string;
    readonly passportSettings: string;
    readonly collaborationTasks: string;
  };
  readonly brand: {
    readonly websiteLabel: string;
  };
  readonly connections: {
    readonly surfaceLabel: string;
    readonly panel: {
      readonly placeholder: string;
      readonly inputLabel: string;
      readonly connectAction: string;
      readonly eyes: {
        readonly open: string;
        readonly connecting: string;
        readonly transitioning: string;
        readonly close: string;
      };
      readonly messages: Record<
        "connecting" | "invalid_public_id" | "request_sent" | "approval_required"
          | "connected" | "already_connected" | "connection_timeout"
          | "identity_not_found" | "connection_failed",
        string
      >;
    };
    readonly list: {
      readonly label: string;
      readonly unnamed: string;
      readonly idUnavailable: string;
      readonly identity: string;
      readonly identityWithoutId: string;
      readonly compatibility: {
        readonly compatible: string;
        readonly upgradeRequired: string;
        readonly checking: string;
        readonly upgradeHint: string;
        readonly checkingHint: string;
      };
      readonly reachability: {
        readonly reachable: string;
        readonly checking: string;
        readonly unreachable: string;
        readonly peerStatus: string;
      };
      readonly accept: string;
      readonly reject: string;
      readonly accepting: string;
      readonly rejecting: string;
      readonly acceptFailed: string;
      readonly rejectFailed: string;
      readonly waitingApproval: string;
      readonly rejected: string;
      readonly expandDetails: string;
      readonly collapseDetails: string;
      readonly unknownPeer: string;
    };
    readonly details: {
      readonly fullDetailsLabel: string;
      readonly sectionLabel: string;
      readonly itemCount: PluralMessages;
      readonly notShared: string;
      readonly quotaUnavailable: string;
      readonly approximatePrefix: string;
      readonly remainingQuota: string;
      readonly providerUnspecified: string;
      readonly inputModes: string;
      readonly outputModes: string;
      readonly listSeparator: string;
      readonly resourceAssociation: string;
      readonly agentAssociation: string;
      readonly bindingUnavailable: string;
      readonly emptyBinding: string;
      readonly localCompute: string;
      readonly overflow: string;
      readonly notes: {
        readonly stale: string;
        readonly disabled: string;
        readonly empty: string;
      };
      readonly resourceKinds: {
        readonly subscription: string;
        readonly account: string;
        readonly localModel: string;
        readonly compute: string;
      };
      readonly assurances: {
        readonly providerObserved: string;
        readonly localObserved: string;
        readonly selfDeclared: string;
      };
      readonly planUnavailable: string;
      readonly planUnknown: string;
      readonly quotaPeriods: {
        readonly week: string;
        readonly day: string;
        readonly hour: string;
      };
      readonly windowUnknown: string;
      readonly daysWindow: PluralMessages;
      readonly hoursWindow: PluralMessages;
      readonly secondsWindow: PluralMessages;
      readonly modes: {
        readonly image: string;
        readonly text: string;
      };
      readonly availability: {
        readonly available: string;
        readonly stale: string;
        readonly unavailable: string;
        readonly unknown: string;
      };
      readonly resetUnavailable: string;
      readonly resetAt: string;
      readonly agent: {
        readonly versionNotShared: string;
        readonly informationStale: string;
        readonly callable: string;
        readonly running: string;
        readonly installedUnknown: string;
        readonly installed: string;
        readonly notFound: string;
        readonly unconfirmed: string;
        readonly versionUnknown: string;
        readonly processes: PluralMessages;
      };
      readonly binding: {
        readonly complete: string;
        readonly incomplete: string;
      };
      readonly computeOffer: {
        readonly resource: string;
        readonly execution: string;
        readonly concurrency: string;
        readonly approval: string;
      };
      readonly capabilityCategories: {
        readonly coding: string;
        readonly codeAnalysis: string;
      };
    };
  };
  readonly passport: {
    readonly title: string;
    readonly summary: {
      readonly resources: PluralMessages;
      readonly agents: PluralMessages;
      readonly capabilities: PluralMessages;
    };
    readonly sections: {
      readonly resources: string;
      readonly agents: string;
      readonly capabilities: string;
    };
    readonly usage: {
      readonly remainingQuota: string;
      readonly approximatePrefix: string;
      readonly inferredFromLongestWindow: string;
      readonly stale: string;
      readonly signedOut: string;
      readonly unavailable: string;
      readonly unknownPlan: string;
    };
    readonly settings: {
      readonly title: string;
      readonly caption: string;
      readonly myTeti: string;
      readonly networkIdentity: string;
      readonly sharing: string;
      readonly sharingHint: string;
      readonly language: {
        readonly label: string;
        readonly title: string;
        readonly hint: string;
        readonly options: {
          readonly auto: string;
          readonly chinese: string;
          readonly english: string;
        };
      };
      readonly errors: {
        readonly sharingSave: string;
        readonly agentRescan: string;
        readonly agentPathSave: string;
        readonly osaurusSave: string;
        readonly networkEnvironmentSave: string;
        readonly localReset: string;
      };
      readonly networkIdentityStatus: {
        readonly active: string;
        readonly checking: string;
        readonly synchronizing: string;
        readonly unavailable: string;
        readonly unauthorized: string;
        readonly revoked: string;
        readonly conflict: string;
      };
      readonly networkVersion: {
        readonly checking: string;
        readonly unavailable: string;
        readonly compatible: string;
      };
      readonly presence: {
        readonly stopped: string;
        readonly sleeping: string;
        readonly checking: string;
        readonly unavailable: string;
        readonly unauthorized: string;
        readonly connected: string;
        readonly modes: {
          readonly collaborating: string;
          readonly viewingConnect: string;
          readonly background: string;
          readonly online: string;
        };
      };
      readonly networkEnvironment: {
        readonly label: string;
        readonly title: string;
        readonly localHint: string;
        readonly productionHint: string;
        readonly localActive: string;
        readonly productionActive: string;
        readonly restartRequired: string;
      };
      readonly build: {
        readonly label: string;
        readonly appVersion: string;
        readonly buildTimestamp: string;
        readonly networkVersion: string;
        readonly resetLocalTeti: string;
        readonly resetting: string;
        readonly cancelReset: string;
        readonly resetLabel: string;
        readonly cancelResetLabel: string;
        readonly confirmationLabel: string;
        readonly warning: string;
        readonly confirmReset: string;
      };
      readonly agentManagement: {
        readonly title: string;
        readonly found: PluralMessages;
        readonly noneFound: string;
        readonly discovering: string;
        readonly rescanning: string;
        readonly disabled: string;
        readonly partiallyComplete: string;
        readonly detectorWarning: string;
        readonly rescan: string;
        readonly scanning: string;
        readonly pending: string;
        readonly empty: string;
        readonly privacy: string;
        readonly customPathEnabled: string;
        readonly pathOverride: string;
        readonly pathLabel: string;
        readonly pathPlaceholder: string;
        readonly saving: string;
        readonly save: string;
        readonly clear: string;
      };
      readonly osaurus: {
        readonly label: string;
        readonly title: string;
        readonly hint: string;
        readonly statuses: {
          readonly ready: string;
          readonly blocked: string;
          readonly checking: string;
          readonly unconfigured: string;
        };
        readonly statusWithReason: string;
        readonly uuidLabel: string;
        readonly uuidPlaceholder: string;
        readonly checkingAction: string;
        readonly saveAction: string;
        readonly clearAction: string;
        readonly policy: string;
        readonly insightsRetentionAccepted: string;
      };
    };
  };
  readonly memory: {
    readonly label: string;
    readonly title: string;
    readonly hint: string;
    readonly exportAction: string;
    readonly taskNote: string;
    readonly authorizationDescription: string;
    readonly authorizationLabel: string;
    readonly emptyAgents: string;
    readonly savedRecords: PluralMessages;
    readonly provenance: string;
    readonly expires: string;
    readonly deleteAction: string;
    readonly exported: string;
    readonly invalidDate: string;
    readonly scopes: {
      readonly workspace: string;
      readonly childAgent: string;
    };
    readonly errors: Record<
      "read_failed" | "operation_failed" | "authorization_required"
        | "source_invalid" | "scope_invalid" | "store_full",
      string
    >;
    readonly task: {
      readonly note: string;
      readonly unavailable: string;
      readonly childLabel: string;
      readonly childDescription: string;
      readonly workspaceLabel: string;
      readonly workspaceDescription: string;
      readonly authorizationLabel: string;
      readonly saved: string;
      readonly saveResult: string;
    };
  };
  readonly tasks: {
    readonly surfaceLabel: string;
    readonly header: {
      readonly backToIsland: string;
      readonly backToInbox: string;
      readonly inbox: string;
      readonly compose: string;
      readonly detail: string;
      readonly pending: PluralMessages;
      readonly semanticCaption: string;
      readonly newTask: string;
    };
    readonly peerHeading: {
      readonly incoming: string;
      readonly outgoing: string;
      readonly invalidTime: string;
    };
    readonly inbox: {
      readonly emptyTitle: string;
      readonly emptyNote: string;
      readonly composeAction: string;
      readonly imageProgress: string;
    };
    readonly composer: {
      readonly peer: string;
      readonly capability: string;
      readonly localCompute: string;
      readonly mode: string;
      readonly singleStage: string;
      readonly longHorizon: string;
      readonly promptPlaceholder: string;
      readonly promptLabel: string;
      readonly addImages: string;
      readonly hints: {
        readonly longHorizon: string;
        readonly localCompute: string;
        readonly imageResultWithInput: string;
        readonly imageResult: string;
        readonly images: string;
        readonly textOnly: string;
      };
      readonly sending: string;
      readonly send: string;
      readonly multiImageWarning: string;
      readonly noCapabilities: string;
    };
    readonly detail: {
      readonly localComputeOffer: string;
      readonly osaurusOffer: string;
      readonly capability: string;
      readonly fullTask: string;
      readonly imageReceiving: string;
      readonly imageUnavailable: string;
      readonly localExecution: string;
      readonly authorization: {
        readonly loginTitle: string;
        readonly agentTitle: string;
        readonly onceTitle: string;
        readonly loginDetail: string;
        readonly localComputeDetail: string;
        readonly osaurusDetail: string;
        readonly defaultDetail: string;
      };
      readonly artifact: {
        readonly title: string;
        readonly final: string;
        readonly intermediate: string;
        readonly resultImageReceiving: string;
        readonly hostFinal: string;
        readonly childIntermediate: string;
      };
      readonly safeCode: string;
      readonly actions: {
        readonly reject: string;
        readonly retryAfterLogin: string;
        readonly allowOnce: string;
        readonly resumeCheckpoint: string;
        readonly stop: string;
        readonly cancel: string;
      };
    };
    readonly status: {
      readonly canceling: string;
      readonly agentLogin: string;
      readonly awaitingConfirmation: string;
      readonly receivingImages: string;
      readonly awaitingPeer: string;
      readonly resultReceiving: string;
      readonly unknown: string;
      readonly states: Record<
        "submitted" | "working" | "completed" | "failed" | "canceled"
          | "rejected" | "input_required" | "auth_required",
        string
      >;
    };
    readonly executionProgress: Record<
      "queued" | "running" | "paused" | "interrupted" | "canceling"
        | "canceled" | "completed" | "failed" | "unknown",
      string
    >;
    readonly longHorizon: {
      readonly delegationTitle: string;
      readonly collaborationTitle: string;
      readonly workspaceExpiry: string;
      readonly boundary: string;
      readonly childStep: string;
      readonly hostStep: string;
      readonly aggregationDetail: string;
      readonly budget: string;
      readonly stage: string;
      readonly structuredMemory: {
        readonly title: string;
        readonly automaticNote: string;
        readonly loading: string;
        readonly unavailable: string;
        readonly ready: string;
        readonly stage: string;
      };
      readonly phase: Record<
        "pending_approval" | "queued" | "working" | "input_required" | "paused"
          | "interrupted" | "completed" | "failed" | "canceled" | "expired" | "unknown",
        string
      >;
      readonly progress: Record<
        "queued" | "running" | "paused" | "interrupted" | "canceling"
          | "canceled" | "completed" | "failed" | "unknown",
        string
      >;
      readonly nextInstructionPlaceholder: string;
      readonly nextInstructionLabel: string;
      readonly sendInstruction: string;
      readonly pauseRequested: string;
      readonly pauseAfterStage: string;
      readonly supplementalInstruction: string;
      readonly continueWithAgent: string;
      readonly startNextStage: string;
      readonly acceptCurrentResult: string;
      readonly renewOneHour: string;
      readonly recoveryAudit: PluralMessages;
      readonly delegationAudit: PluralMessages;
      readonly auditStage: string;
      readonly auditActions: Record<
        "session_created" | "stage_started" | "progress_updated" | "artifact_published"
          | "checkpoint_created" | "input_requested" | "input_received"
          | "pause_requested" | "paused" | "resumed" | "child_selected"
          | "stage_failed" | "renewed" | "completed" | "canceled" | "expired"
          | "restart_reconciled",
        string
      >;
      readonly delegationAuditActions: Record<
        "plan_created" | "plan_approved" | "step_started" | "artifact_recorded"
          | "step_completed" | "step_failed" | "aggregation_started"
          | "plan_completed" | "plan_canceled" | "restart_reconciled",
        string
      >;
      readonly approval: {
        readonly title: string;
        readonly plannerDisabled: string;
        readonly note: string;
        readonly step: string;
        readonly targetUnavailable: string;
        readonly remove: string;
        readonly removeLabel: string;
        readonly add: string;
        readonly approve: string;
      };
      readonly delegationStepStates: Record<
        "pending" | "working" | "completed" | "failed" | "canceled" | "interrupted",
        string
      >;
      readonly workspacePolicies: Record<"snapshot" | "bounded_context" | "none", string>;
    };
    readonly images: {
      readonly alt: string;
      readonly remove: string;
      readonly open: string;
      readonly reveal: string;
      readonly saveAs: string;
    };
    readonly errors: Record<
      "draft_incomplete" | "operation_timeout" | "transport_failed"
        | "result_image_unavailable" | "result_image_invalid"
        | "result_image_unsupported" | "result_image_open_failed"
        | "result_image_reveal_failed" | "result_image_save_failed"
        | "result_image_action_unsupported" | "operation_failed",
      string
    >;
  };
  readonly nativeDialogs: {
    readonly taskImages: {
      readonly selectTitle: string;
      readonly selectFilter: string;
      readonly saveTitle: string;
      readonly saveFilter: string;
    };
  };
}

export interface FormatPluralOptions {
  readonly number?: Intl.NumberFormatOptions;
  readonly plural?: Intl.PluralRulesOptions;
}

export interface DesktopFormatters {
  formatDate(
    value: Date | number,
    options?: Intl.DateTimeFormatOptions
  ): string;
  formatDateTime(
    value: Date | number,
    options?: Intl.DateTimeFormatOptions
  ): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  pluralCategory(value: number, options?: Intl.PluralRulesOptions): PluralCategory;
  formatPlural(
    value: number,
    messages: PluralMessages,
    options?: FormatPluralOptions
  ): string;
}

export interface DesktopI18n extends DesktopFormatters {
  readonly locale: AppLocale;
  readonly direction: TextDirection;
  readonly messages: AppMessages;
}
