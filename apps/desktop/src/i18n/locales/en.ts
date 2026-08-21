import type { AppMessages } from "../types.ts";

export const EN_MESSAGES = {
  common: {
    appName: "Teti",
    unknown: "Unknown",
    unavailable: "Unavailable",
    actions: {
      cancel: "Cancel",
      close: "Close",
      continue: "Continue",
      delete: "Delete",
      done: "Done",
      retry: "Retry",
      save: "Save"
    },
    units: {
      items: { one: "# item", other: "# items" },
      seconds: { one: "# second", other: "# seconds" },
      hours: { one: "# hour", other: "# hours" },
      days: { one: "# day", other: "# days" }
    }
  },
  shell: {
    nameInputLabel: "Teti name",
    openTeti: "Open Teti",
    openPendingTasks: { one: "Open Teti Tasks, # task awaiting approval", other: "Open Teti Tasks, # tasks awaiting approval" },
    openPendingConnections: { one: "Open Teti Connections, # request awaiting approval", other: "Open Teti Connections, # requests awaiting approval" }
  },
  firstLaunch: {
    booting: { message: "Waking up", progress: "Waking up" },
    welcome: {
      title: "Hello, human.",
      message: "We’re meeting for the first time. Give me a name.",
      action: "Continue"
    },
    naming: {
      title: "Give me a name.",
      message: "A short name fits the notch best.",
      action: "Create",
      placeholder: "Name"
    },
    creating: {
      title: "Creating Teti",
      phases: {
        preparing: { label: "Waking up", message: "Waking up" },
        provisioning_chatmail: { label: "Creating identity", message: "Creating identity" },
        persisting_account: { label: "Saving", message: "Saving on this Mac" },
        registering_identity: { label: "Connecting", message: "Connecting" },
        verifying_account: { label: "Checking", message: "Checking" },
        finalizing: { label: "Ready", message: "Teti is ready." }
      }
    },
    ready: { message: "I’m ready.", action: "Done", progress: "Ready" },
    idleMessage: "Nearby",
    recoverable: {
      title: "Teti needs a moment",
      titleWithCode: "Teti needs a moment [{code}]",
      retryAction: "Try again",
      retryConnectionAction: "Connect again"
    },
    fatalTitle: "Teti can’t continue right now",
    validation: {
      empty: "Give your Teti a name.",
      tooLong: "Names can contain at most {maximum} characters.",
      controlCharacter: "Names can’t contain control characters.",
      generic: "That name can’t be used right now."
    },
    errors: {
      temporaryAccountLoad: "Teti can’t check the local identity right now.",
      corruptAccount: "Teti found local identity data that needs repair.",
      partialAccount: "Teti’s local identity isn’t complete.",
      chatmailProvisioning: "Chatmail identity setup didn’t finish.",
      localPersistence: "Teti can’t safely save the local identity.",
      networkIdentity: "Teti hasn’t finished connecting yet.",
      loadedAccountVerification: "Teti can’t verify the local identity.",
      runtimeStartup: "The local Runtime couldn’t start. Quit Teti and try again.",
      internalState: "Teti encountered an internal setup problem.",
      unknown: "Teti hasn’t finished yet."
    }
  },
  updateBlocker: {
    title: "This Teti needs an update",
    message: "This version is below the current Beta support threshold. Install the latest Teti. Versions on connected devices never lock this Mac.",
    status: "Local {currentVersion} · Minimum supported {minimumVersion} · Build {buildTimestamp}",
    unknownMinimumVersion: "Checking"
  },
  toolbar: {
    aiPassport: "View AI Passport: {plan}",
    aiPassportUnavailable: "Unable to confirm",
    passportSharingEnabled: "Passport sharing is on",
    passportSettings: "Open Passport settings",
    collaborationTasks: "Collaboration tasks"
  },
  brand: {
    websiteLabel: "Visit the {brand} website"
  },
  connections: {
    surfaceLabel: "Connect with another Teti",
    panel: {
      placeholder: "********* (9-character teti.bot community ID)",
      inputLabel: "9-character Teti community ID",
      connectAction: "Connect",
      eyes: {
        open: "Open connection input",
        connecting: "Connecting",
        transitioning: "Connection input is transitioning",
        close: "Close connection input"
      },
      messages: {
        connecting: "Connecting…",
        invalid_public_id: "Enter a valid 9-character ID",
        request_sent: "Connection request sent",
        approval_required: "The other Teti is waiting for your approval",
        connected: "Connected",
        already_connected: "You’re already connected",
        connection_timeout: "Connection timed out. Try again later",
        identity_not_found: "Teti not found. Check the ID",
        connection_failed: "Couldn’t connect right now. Try again later"
      }
    },
    list: {
      label: "Connected Teti list",
      unnamed: "Unnamed",
      idUnavailable: "ID unavailable",
      identity: "{name} ({id})",
      identityWithoutId: "{name} (ID unavailable)",
      compatibility: {
        compatible: "Compatible",
        upgradeRequired: "Update required",
        checking: "Checking version",
        unavailable: "Protocol status unavailable",
        upgradeHint: "Collaboration with this Teti only is paused",
        checkingHint: "Local features remain available",
        unavailableHint: "Connected · retrying automatically"
      },
      reachability: {
        reachable: "Online",
        checking: "Checking status",
        unreachable: "Offline",
        unavailable: "Status temporarily unavailable",
        peerStatus: "Peer {status}"
      },
      accept: "Accept connection",
      reject: "Reject connection",
      accepting: "Accepting…",
      rejecting: "Rejecting…",
      acceptFailed: "Couldn’t accept. Try again",
      rejectFailed: "Couldn’t reject. Try again",
      waitingApproval: "Waiting for approval",
      rejected: "Rejected",
      expandDetails: "Expand {identity} AI Passport details",
      collapseDetails: "Collapse {identity} AI Passport details",
      unknownPeer: "this Teti"
    },
    details: {
      fullDetailsLabel: "Full AI Passport details",
      sectionLabel: "{entity}, {count}",
      itemCount: { one: "# item", other: "# items" },
      notShared: "This information wasn’t shared",
      quotaUnavailable: "Quota not provided",
      approximatePrefix: "About ",
      remainingQuota: "{product} {period} remaining quota",
      providerUnspecified: "Provider not specified",
      inputModes: "Input: {modes}",
      outputModes: "Output: {modes}",
      listSeparator: ", ",
      resourceAssociation: "Resources: {items}",
      agentAssociation: "Agents: {items}",
      bindingUnavailable: "Binding not provided",
      emptyBinding: "Empty binding",
      localCompute: "Local compute",
      overflow: "{count} more {entity}",
      notes: {
        stale: "AI Passport has expired",
        disabled: "The other Teti isn’t sharing its AI Passport",
        unknown: "Getting the other Teti’s AI Passport status",
        empty: "No AI Passport"
      },
      resourceKinds: {
        subscription: "Subscription resource",
        account: "Account resource",
        localModel: "Local model",
        compute: "Compute resource"
      },
      assurances: {
        providerObserved: "Observed by provider",
        localObserved: "Observed locally",
        selfDeclared: "Declared by node"
      },
      planUnavailable: "Unable to confirm",
      planUnknown: "Plan unknown",
      quotaPeriods: { week: "Weekly quota", day: "Daily quota", hour: "Hourly quota" },
      windowUnknown: "Window duration unknown",
      daysWindow: { one: "# day window", other: "# days window" },
      hoursWindow: { one: "# hour window", other: "# hours window" },
      secondsWindow: { one: "# second window", other: "# seconds window" },
      modes: { image: "Image", text: "Text" },
      availability: {
        available: "Available",
        stale: "Data expired",
        unavailable: "Unavailable",
        unknown: "Unable to confirm"
      },
      resetUnavailable: "Reset time unavailable",
      resetAt: "Resets {date}",
      agent: {
        versionNotShared: "Version not shared",
        informationStale: "Information expired",
        callable: "Callable",
        running: "Running",
        installedUnknown: "Installed · Status unknown",
        installed: "Installed",
        notFound: "Not found",
        unconfirmed: "Unconfirmed",
        versionUnknown: "Version unknown",
        processes: { one: "# process", other: "# processes" }
      },
      binding: { complete: "Binding complete", incomplete: "Binding incomplete" },
      computeOffer: {
        resource: "Local compute",
        execution: "Runs locally on the receiver",
        concurrency: "Concurrency 1",
        approval: "Approval every time"
      },
      capabilityCategories: { coding: "Coding", codeAnalysis: "Code analysis" }
    }
  },
  passport: {
    title: "AI Passport",
    summary: {
      resources: { one: "# AI resource", other: "# AI resources" },
      agents: { one: "# available Agent", other: "# available Agents" },
      capabilities: { one: "# capability", other: "# capabilities" }
    },
    sections: {
      resources: "AI resources",
      agents: "Available Agents",
      capabilities: "Callable capabilities"
    },
    usage: {
      remainingQuota: "Remaining quota",
      approximatePrefix: "About ",
      inferredFromLongestWindow: "Estimated from the longest window",
      stale: "Data may be out of date",
      signedOut: "Signed out",
      unavailable: "Unavailable",
      unknownPlan: "Unknown plan"
    },
    settings: {
      title: "Settings",
      caption: "Identity, sharing, and local Agents",
      myTeti: "My Teti",
      networkIdentity: "Network identity",
      sharing: "Passport sharing",
      sharingHint: "Share the current Passport with connected Teti",
      language: {
        label: "Teti display language",
        title: "Language",
        hint: "Choose the language used by the Teti interface",
        options: {
          auto: "Automatic detection",
          chinese: "中文",
          english: "English"
        }
      },
      errors: {
        sharingSave: "Passport sharing settings couldn’t be saved.",
        agentRescan: "Agents couldn’t be rescanned right now.",
        agentPathSave: "The path is invalid or the local Agent setting couldn’t be saved.",
        osaurusSave: "The fixed Agent ID is invalid or the local setting couldn’t be saved.",
        networkEnvironmentSave: "The Network development setting couldn’t be saved.",
        localReset: "Teti couldn’t be reset on this device. Quit the app and try again."
      },
      networkIdentityStatus: {
        active: "Connected to Network",
        checking: "Checking",
        synchronizing: "Synchronizing identity",
        unavailable: "Network unavailable [{code}]",
        unauthorized: "Network identity authentication failed",
        revoked: "Network client revoked",
        conflict: "Network identity conflict"
      },
      networkVersion: {
        checking: "Checking",
        unavailable: "Unavailable",
        compatible: "Protocol {protocol} · Service {service}"
      },
      presence: {
        stopped: "Not started",
        sleeping: "System asleep · Reporting paused",
        checking: "Connecting",
        unavailable: "Network unavailable",
        unauthorized: "Network identity authentication failed",
        connected: "Connected · {mode}",
        modes: {
          collaborating: "AI collaboration active",
          viewingConnect: "Viewing connections",
          background: "Online in background",
          online: "Online"
        }
      },
      networkEnvironment: {
        label: "Teti Network environment",
        title: "Local Network development environment",
        localHint: "Connect to local teti-network on next launch",
        productionHint: "Connect to network.teti.bot by default",
        localActive: "Local development",
        productionActive: "Production",
        restartRequired: "Setting saved; {endpoint} will be used after restart"
      },
      build: {
        label: "Teti version and build information",
        appVersion: "App version",
        buildTimestamp: "Build time (UTC)",
        networkVersion: "teti-network version",
        resetLocalTeti: "Reset Teti",
        resetting: "Resetting…",
        cancelReset: "Cancel reset",
        resetLabel: "Reset Teti on this device and erase the local Profile",
        cancelResetLabel: "Cancel reset of Teti on this device",
        confirmationLabel: "Confirm reset of Teti on this device",
        warning: "This permanently erases the Teti Profile stored on this device, including Network credentials, connection cache, messages, tasks, and Child Memory. Your server-side identity and data are not deleted.",
        confirmReset: "Erase and reset"
      },
      agentManagement: {
        title: "Agent management",
        found: { one: "Found #", other: "Found #" },
        noneFound: "No local Agents found",
        discovering: "Discovering local Agents…",
        rescanning: "Scanning again…",
        disabled: "Agent discovery is off",
        partiallyComplete: "{status} · Some checks didn’t finish",
        detectorWarning: "Some detectors didn’t finish; other Agents are unaffected.",
        rescan: "Scan again",
        scanning: "Scanning",
        pending: "Agents will appear after the first security scan finishes.",
        empty: "No installed Agents were detected.",
        privacy: "Only installation, version, and running status are checked. Paths stay on this device.",
        customPathEnabled: "Custom path enabled",
        pathOverride: "Path override",
        pathLabel: "Custom installation path for {agent}",
        pathPlaceholder: "Absolute executable path",
        saving: "Saving",
        save: "Save",
        clear: "Clear"
      },
      osaurus: {
        label: "Osaurus Native Child Agent",
        title: "Osaurus Native Child",
        hint: "Fixed dedicated Agent ID · Uses the local Agent configuration",
        statuses: {
          ready: "Callable",
          blocked: "Security qualification failed",
          checking: "Checking security qualification",
          unconfigured: "Not configured"
        },
        statusWithReason: "{status}: {reason}",
        uuidLabel: "Fixed Osaurus Agent UUID",
        uuidPlaceholder: "Agent UUID",
        checkingAction: "Checking",
        saveAction: "Save",
        clearAction: "Clear",
        policy: "Teti doesn’t change Tools, Osaurus Memory, or Autonomous Exec. Direct Host Workspace mounts remain blocked, and the Runtime identity must pass validation before entering Passport.",
        insightsRetentionAccepted: "Osaurus Insights retains request bodies; calls are allowed under the local Agent trust policy."
      }
    }
  },
  memory: {
    label: "Child Agent Memory",
    title: "Child Memory",
    hint: "Managed by Teti · Off by default",
    exportAction: "Export",
    taskNote: "Task Memory exists only for one execution. Long-term Memory must be authorized first and then saved separately from a completed task; the remote peer can’t trigger a write.",
    authorizationDescription: "Allow completed results to be saved as long-term context for this Child Agent",
    authorizationLabel: "{agent} Child Agent Memory",
    emptyAgents: "When an available Child Agent is detected, you can authorize its long-term Memory here.",
    savedRecords: { one: "# saved record", other: "# saved records" },
    provenance: "{scope} · {agent} · Source task {task} · Peer {peer}",
    expires: "Expires {date}",
    deleteAction: "Delete",
    exported: "Exported {count} records: {path}",
    invalidDate: "Unknown",
    scopes: { workspace: "Workspace Memory", childAgent: "Child Agent Memory" },
    errors: {
      read_failed: "Child Memory can’t be read right now.",
      authorization_required: "Explicitly enable the matching long-term Memory authorization first.",
      source_invalid: "This task has no local text result that can be saved.",
      scope_invalid: "This Workspace doesn’t allow this type of Memory write.",
      store_full: "Child Memory has reached its local record limit.",
      operation_failed: "The local Child Memory operation didn’t finish. Check the authorization and task state, then try again."
    },
    task: {
      note: "Task Memory exists only for this execution. To keep it long term, authorize the scope first and then save the completed result separately.",
      unavailable: "After a local Child Agent completes a text task, you can choose to save it. Remote task content never enters long-term Memory automatically.",
      childLabel: "{agent} long-term Memory",
      childDescription: "Available only to later tasks from the same Child Agent",
      workspaceLabel: "Workspace Memory",
      workspaceDescription: "Available only to this Workspace and Child Agent",
      authorizationLabel: "Authorize {label}",
      saved: "Saved",
      saveResult: "Save result"
    }
  },
  tasks: {
    surfaceLabel: "Teti collaboration tasks",
    header: {
      backToIsland: "Back to Teti",
      backToInbox: "Back to task list",
      inbox: "Collaboration tasks",
      compose: "Start collaboration",
      detail: "Task details",
      pending: { one: "# awaiting confirmation", other: "# awaiting confirmation" },
      semanticCaption: "Task · A2A semantics",
      newTask: "Start a new task"
    },
    peerHeading: {
      incoming: "Collaboration request from {name} [{date}]",
      outgoing: "Collaboration request sent to {name} [{date}]",
      invalidTime: "Unknown time"
    },
    inbox: {
      emptyTitle: "No collaboration tasks yet",
      emptyNote: "Choose a capability from a connected Teti’s Passport and send a text or image task.",
      composeAction: "Start a task",
      imageProgress: "{received}/{total} images"
    },
    composer: {
      peer: "Send to",
      capability: "Capability",
      localCompute: "Local compute",
      mode: "Collaboration mode",
      singleStage: "Single call",
      longHorizon: "Ongoing collaboration",
      promptPlaceholder: "Describe clearly what you want the other AI to do…",
      promptLabel: "Task content",
      addImages: "Add images",
      hints: {
        longHorizon: "Ongoing collaboration · Text only · Host explicitly advances each stage · Up to 16 stages",
        localCompute: "Receiver-local compute · Text only · Concurrency 1 · Approval every time",
        imageResultWithInput: "PNG/JPEG · Up to 4 images · Result must include an image",
        imageResult: "Result must include an image",
        images: "Text required · PNG/JPEG · Up to 4 images",
        textOnly: "This capability currently accepts text only"
      },
      sending: "Sending…",
      send: "Send task",
      multiImageWarning: "Known 0.4.0 limitation: multi-image delivery is still under device validation. The receiver can’t approve or run the task until every image arrives.",
      noCapabilities: "No callable capabilities"
    },
    detail: {
      localComputeOffer: "General text assistance · Receiver-local compute",
      osaurusOffer: "General text assistance · Osaurus Native Agent",
      capability: "Capability · {capability}",
      fullTask: "Full task",
      imageReceiving: "Receiving images {received}/{total}…",
      imageUnavailable: "Image unavailable",
      localExecution: "Local execution · Run {epoch}",
      authorization: {
        loginTitle: "After Agent sign-in · Allow once again",
        agentTitle: "{agent} · Allow once",
        onceTitle: "Allow once",
        loginDetail: "Teti doesn’t store sign-in credentials. Sign in to the Agent on this device, then authorize this task again.",
        localComputeDetail: "Runs only this task. The receiver resolves the Runtime and model locally without exposing ports, paths, hardware, or credentials to the peer.",
        osaurusDetail: "Runs only this task with the receiver’s fixed Osaurus Agent. Tools, native Memory, Host Workspace, and Autonomous Exec must remain off.",
        defaultDetail: "Runs only this task. The Agent is revalidated on approval; no file, command, or ongoing permission is granted."
      },
      artifact: {
        title: "{role} Artifact · Stage {stage}",
        final: "Final",
        intermediate: "Intermediate",
        resultImageReceiving: "Receiving result image…",
        hostFinal: "Final Artifact · Teti Host aggregation · Workspace r{revision}",
        childIntermediate: "Intermediate Artifact · Step {step} · {agent} · {resource} · Workspace r{revision}"
      },
      safeCode: "Status code: {code}",
      actions: {
        reject: "Reject",
        retryAfterLogin: "Retry once after sign-in",
        allowOnce: "Allow once",
        resumeCheckpoint: "Restart from checkpoint",
        stop: "Stop task",
        cancel: "Cancel task"
      }
    },
    status: {
      canceling: "Canceling",
      agentLogin: "Agent sign-in required",
      awaitingConfirmation: "Awaiting your confirmation",
      receivingImages: "Receiving images",
      awaitingPeer: "Awaiting peer confirmation",
      resultReceiving: "Task completed · Receiving result",
      unknown: "Unknown status",
      states: {
        submitted: "Submitted",
        working: "Working",
        completed: "Completed",
        failed: "Failed",
        canceled: "Canceled",
        rejected: "Rejected",
        input_required: "Input required",
        auth_required: "Authorization required"
      }
    },
    executionProgress: {
      queued: "Waiting for local Child Agent",
      running: "Local Child Agent is running",
      paused: "Execution paused",
      interrupted: "Execution interrupted",
      canceling: "Canceling execution",
      canceled: "Execution canceled",
      completed: "Execution completed",
      failed: "Execution failed",
      unknown: "Execution status is updating"
    },
    longHorizon: {
      delegationTitle: "Teti Host delegation · Step {current}/{total}",
      collaborationTitle: "Ongoing collaboration · Stage {stage}",
      workspaceExpiry: "Workspace r{revision} · Renews until {date}",
      boundary: "Deterministic plan · Depth 1 · Planner off · Child can’t contact peers or expand Workspace access",
      childStep: "Step {step} · {agent}",
      hostStep: "Step {step} · Teti Host",
      aggregationDetail: "Deterministic Artifact aggregation · {state}",
      budget: "Workspace r{revision} · {seconds}s · Output limit {kib} KiB",
      stage: "Stage {stage} · {agent}",
      structuredMemory: {
        title: "Local ongoing-collaboration memory",
        automaticNote: "Stage results first become SQLite source drafts. Only items you confirm and edit can enter an execution preview. Legacy Memory is not used.",
        loading: "Reading local memory status…",
        unavailable: "Local memory is unavailable. Task results remain intact, and Runtime will retry on a later read.",
        readOnly: "SQLite is in safe read-only mode. {count} stages remain viewable, but nothing is written or injected.",
        ready: "SQLite contains {count} saved stages",
        stage: "Stage {stage} · {agent}",
        prepare: "Prepare memory",
        edit: "Edit",
        delete: "Delete",
        confirmDelete: "Confirm delete",
        deleteWarning: "Deletion immediately removes text, search index, and future injection eligibility; only a content-free audit remains.",
        cancel: "Cancel",
        save: "Confirm and save",
        editorTitle: "Structured memory editor",
        titleField: "Title",
        contentField: "Reference text to save",
        scopeField: "Scope",
        kindField: "Kind",
        pinned: "Pin for ranking",
        expiryField: "Expiry (optional)",
        expiryHint: "Leave blank for no automatic expiry. Expired items stop retrieval immediately and are cleaned during local maintenance.",
        scopesTitle: "Exact scope authorization",
        scopes: { task: "Current Task", workspace: "Current Workspace", peer: "Current peer" },
        scopeEnabled: "Enabled · {count} eligible",
        scopeDisabled: "Off by default · {count} candidates",
        candidatesTitle: "Read-only preview for the next execution",
        candidatesEmpty: "No injectable items. Prepare a stage result or enable an exact scope authorization.",
        temporaryExclude: "Included this time; uncheck to exclude temporarily",
        budgetExcluded: "Not included: candidate or byte budget reached",
        injectNext: "Inject the items above for the next execution only",
        injectNote: "Off by default and consumed once. Expiry, edits, deletion, or authorization changes degrade safely to a memory-free execution.",
        refreshPreview: "Refresh preview",
        previewSummary: "Will inject {count} items · {bytes} bytes · Child {agent}",
        lastInjection: "Last execution injected {count} items (local audit)",
        kinds: {
          decision: "Decision",
          constraint: "Constraint",
          fact: "Fact",
          open_question: "Open question",
          handoff: "Handoff",
          summary: "Summary",
          local_note: "Local note"
        },
        errors: {
          read_failed: "Memory preview is unavailable; Task approval and continuation remain available.",
          write_failed: "The memory operation did not finish; the Task can still run without memory.",
          preview_stale: "The preview expired or no longer matches the Child/content. This run will be memory-free; refresh and opt in again."
        }
      },
      phase: {
        pending_approval: "Awaiting approval",
        queued: "Queued",
        working: "Running",
        input_required: "Awaiting additional instructions",
        paused: "Paused",
        interrupted: "Interrupted",
        completed: "Completed",
        failed: "Failed",
        canceled: "Canceled",
        expired: "Expired",
        unknown: "Status updating"
      },
      progress: {
        queued: "Stage {stage} is waiting for a local Child Agent",
        running: "Stage {stage} is running · {completed}/{total}",
        paused: "Stage {stage} is paused",
        interrupted: "Stage {stage} was interrupted",
        canceling: "Stage {stage} is canceling",
        canceled: "Stage {stage} was canceled",
        completed: "Stage {stage} completed",
        failed: "Stage {stage} failed",
        unknown: "Stage {stage} status is updating"
      },
      nextInstructionPlaceholder: "Add instructions for the next stage…",
      nextInstructionLabel: "Additional instructions for next stage",
      sendInstruction: "Send instructions",
      pauseRequested: "Will pause at the stage boundary",
      pauseAfterStage: "Pause after stage",
      supplementalInstruction: "Additional instructions: {instruction}",
      continueWithAgent: "Continue with Child Agent",
      startNextStage: "Start next stage",
      acceptCurrentResult: "Accept current result as final",
      renewOneHour: "Renew for 1 hour",
      recoveryAudit: { one: "Recovery and action audit · # event", other: "Recovery and action audit · # events" },
      delegationAudit: { one: "Host delegation audit · # event", other: "Host delegation audit · # events" },
      auditStage: "Stage {stage}",
      auditActions: {
        session_created: "Session created",
        stage_started: "Stage started",
        progress_updated: "Progress updated",
        artifact_published: "Artifact published",
        checkpoint_created: "Checkpoint created",
        input_requested: "Input requested",
        input_received: "Input received",
        pause_requested: "Pause requested",
        paused: "Paused",
        resumed: "Resumed",
        child_selected: "Child Agent selected",
        stage_failed: "Stage failed",
        renewed: "Renewed",
        completed: "Completed",
        canceled: "Canceled",
        expired: "Expired",
        restart_reconciled: "Restart reconciled"
      },
      delegationAuditActions: {
        plan_created: "Plan created",
        plan_approved: "Plan approved",
        step_started: "Step started",
        artifact_recorded: "Artifact recorded",
        step_completed: "Step completed",
        step_failed: "Step failed",
        aggregation_started: "Aggregation started",
        plan_completed: "Plan completed",
        plan_canceled: "Plan canceled",
        restart_reconciled: "Restart reconciled"
      },
      approval: {
        title: "Teti Host delegation plan",
        plannerDisabled: "Planner off",
        note: "You explicitly choose the local Child Agent order. Every step has separate budgets, timeout, and permissions; up to 4 steps, followed by deterministic Teti Host Artifact aggregation.",
        step: "Step {step}",
        targetUnavailable: "Local target needs to be detected again",
        remove: "Remove",
        removeLabel: "Remove delegation step {step}",
        add: "Add step",
        approve: "Delegate with this plan"
      },
      delegationStepStates: {
        pending: "Pending",
        working: "Running",
        completed: "Completed",
        failed: "Failed",
        canceled: "Canceled",
        interrupted: "Interrupted"
      },
      workspacePolicies: {
        snapshot: "Workspace Snapshot",
        bounded_context: "Bounded context",
        none: "No Workspace"
      }
    },
    images: {
      alt: "Task image",
      remove: "Remove image",
      open: "Open result image",
      reveal: "Show in Finder",
      saveAs: "Save as"
    },
    errors: {
      draft_incomplete: "Choose a connected Teti and capability, then describe the task.",
      operation_timeout: "The operation timed out. Runtime will keep the task state.",
      transport_failed: "This task can’t be processed right now.",
      result_image_unavailable: "This task result image isn’t available right now.",
      result_image_invalid: "This task result image is invalid.",
      result_image_unsupported: "This system doesn’t support that image operation.",
      result_image_open_failed: "The task result image couldn’t be opened.",
      result_image_reveal_failed: "The task result image couldn’t be shown in its folder.",
      result_image_save_failed: "The task result image couldn’t be saved.",
      result_image_action_unsupported: "This system doesn’t support that image operation.",
      operation_failed: "This task can’t be processed right now."
    }
  },
  nativeDialogs: {
    taskImages: {
      selectTitle: "Choose task images",
      selectFilter: "Images",
      saveTitle: "Save result image",
      saveFilter: "Image"
    }
  }
} as const satisfies AppMessages;
