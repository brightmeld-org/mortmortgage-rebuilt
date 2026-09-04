-- CreateEnum
CREATE TYPE "WorkflowState" AS ENUM ('draft', 'application_received', 'completeness_validated', 'documents_received', 'aus_executed', 'preliminary_decision', 'escalated_review', 'conditional_approval', 'approved', 'denied', 'borrower_notified', 'revision_requested', 'suspended', 'withdrawn', 'declined_by_borrower');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('BORROWER', 'CASEWORKER', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'inactive');

-- CreateEnum
CREATE TYPE "NotificationChannelPreference" AS ENUM ('email', 'sms', 'both');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('urgent', 'high', 'normal', 'low');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('approved', 'denied');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('married', 'separated', 'unmarried');

-- CreateEnum
CREATE TYPE "CreditType" AS ENUM ('individual', 'joint');

-- CreateEnum
CREATE TYPE "SignatureMode" AS ENUM ('drawn', 'typed', 'demo');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('pending', 'accepted', 'insufficient', 'waived');

-- CreateEnum
CREATE TYPE "DocumentJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "CheckType" AS ENUM ('credit', 'income', 'avm', 'pricing', 'aus');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('running', 'completed', 'error');

-- CreateEnum
CREATE TYPE "RiskBadge" AS ENUM ('green', 'yellow', 'red');

-- CreateEnum
CREATE TYPE "FraudFlagSeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "FraudFlagStatus" AS ENUM ('open', 'resolved', 'dismissed');

-- CreateEnum
CREATE TYPE "AssignmentMethod" AS ENUM ('claim', 'manual', 'bulk', 'auto', 'reassign');

-- CreateEnum
CREATE TYPE "NoteType" AS ENUM ('internal', 'formal', 'chatter');

-- CreateEnum
CREATE TYPE "ConditionStatus" AS ENUM ('open', 'cleared');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('approve', 'deny');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "ExternalChannel" AS ENUM ('email', 'sms');

-- CreateEnum
CREATE TYPE "MfaStatus" AS ENUM ('enrolled', 'pending', 'reset');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "pendingEmail" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "passwordChangedAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "notificationChannel" "NotificationChannelPreference" NOT NULL DEFAULT 'email',
    "smsVerifiedAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "lastSignInAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MfaEnrollment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "secretCiphertext" BYTEA NOT NULL,
    "secretKeyId" TEXT NOT NULL,
    "status" "MfaStatus" NOT NULL DEFAULT 'pending',
    "verifiedAt" TIMESTAMP(3),
    "recoveryCodeHashes" JSONB NOT NULL DEFAULT '[]',
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "applicationNumber" TEXT NOT NULL,
    "borrowerUserId" TEXT NOT NULL,
    "workflowState" "WorkflowState" NOT NULL DEFAULT 'draft',
    "previousStateForSuspend" "WorkflowState",
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "priorityOverride" BOOLEAN NOT NULL DEFAULT false,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 0,
    "versionStamp" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "outcome" "Outcome",
    "stateEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "slaPausedAt" TIMESTAMP(3),
    "revisionCycles" INTEGER NOT NULL DEFAULT 0,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "escalationCriteriaMet" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dti" DECIMAL(8,4),
    "ltv" DECIMAL(8,4),
    "cltv" DECIMAL(8,4),
    "ausStale" BOOLEAN NOT NULL DEFAULT false,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "copiedFromApplicationId" TEXT,
    "decisionNotificationPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Borrower" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "firstName" TEXT,
    "middleName" TEXT,
    "lastName" TEXT,
    "suffix" TEXT,
    "alternateNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ssnCiphertext" BYTEA,
    "ssnKeyId" TEXT,
    "ssnLast4" TEXT,
    "ssnBlindIndex" TEXT,
    "dateOfBirthCiphertext" BYTEA,
    "dateOfBirthKeyId" TEXT,
    "citizenship" TEXT,
    "maritalStatus" "MaritalStatus",
    "dependentsCount" INTEGER,
    "dependentsAges" TEXT,
    "homePhone" TEXT,
    "cellPhone" TEXT,
    "workPhone" TEXT,
    "workPhoneExt" TEXT,
    "email" TEXT,
    "creditType" "CreditType",
    "militaryService" JSONB,
    "currentAddress" JSONB,
    "housingStatus" TEXT,
    "monthlyRent" DECIMAL(12,2),
    "yearsAtAddress" INTEGER,
    "monthsAtAddress" INTEGER,
    "previousAddresses" JSONB,
    "mailingAddress" JSONB,
    "employmentType" TEXT,
    "employments" JSONB,
    "previousEmployments" JSONB,
    "otherIncome" JSONB,
    "declarations" JSONB,
    "demographics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Borrower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationData" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "assets" JSONB,
    "otherCredits" JSONB,
    "realEstateOwned" JSONB,
    "liabilities" JSONB,
    "otherLiabilities" JSONB,
    "subjectProperty" JSONB,
    "loan" JSONB,
    "proposedHousingExpense" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationVersion" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "description" TEXT,
    "checklistItemKey" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "currentVersionId" TEXT,
    "uploadedByUserId" TEXT,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "sniffedContentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentJob" (
    "id" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "status" "DocumentJobStatus" NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "provider" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OcrExtraction" (
    "id" TEXT NOT NULL,
    "documentVersionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "rawText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OcrExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRequest" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "fulfilledByDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "mode" "SignatureMode" NOT NULL,
    "imageData" BYTEA,
    "attestationText" TEXT NOT NULL,
    "attestationVersion" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "dataHash" TEXT NOT NULL,
    "invalidatedAt" TIMESTAMP(3),
    "demoBypass" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLink" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "borrowerId" TEXT,
    "provider" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "accessTokenCiphertext" BYTEA,
    "accessTokenKeyId" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMP(3),
    "importedAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnderwritingResult" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "checkType" "CheckType" NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'running',
    "provider" TEXT,
    "requestedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "summary" TEXT,
    "riskBadge" "RiskBadge",
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "supersededById" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnderwritingResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FraudFlag" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "FraudFlagSeverity" NOT NULL,
    "sourceDocumentVersionId" TEXT,
    "sourceResultId" TEXT,
    "details" TEXT NOT NULL,
    "status" "FraudFlagStatus" NOT NULL DEFAULT 'open',
    "resolvedByUserId" TEXT,
    "resolutionNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FraudFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseworkerAssignment" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "caseworkerUserId" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "method" "AssignmentMethod" NOT NULL,
    "reason" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaseworkerAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRecord" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "approverUserId" TEXT NOT NULL,
    "notes" TEXT,
    "denialReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denialReasonOtherText" TEXT,
    "criteriaEvaluated" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dtiAtDecision" DECIMAL(8,4),
    "ltvAtDecision" DECIMAL(8,4),
    "versionNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Condition" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "approvalRecordId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "ConditionStatus" NOT NULL DEFAULT 'open',
    "clearedByUserId" TEXT,
    "clearedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowHistory" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromState" "WorkflowState" NOT NULL,
    "toState" "WorkflowState" NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "note" TEXT,
    "versionNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationNote" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "type" "NoteType" NOT NULL,
    "content" TEXT NOT NULL,
    "relatedTransitionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "actionType" TEXT NOT NULL,
    "applicationId" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "requestId" TEXT,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "applicationId" TEXT,
    "channel" TEXT NOT NULL,
    "deliveryStatus" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "deliveryError" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "channel" "ExternalChannel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "notificationId" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedRun" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "recordCounts" JSONB NOT NULL,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeedRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE INDEX "User_isSeed_idx" ON "User"("isSeed");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "MfaEnrollment_userId_status_idx" ON "MfaEnrollment"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_purpose_idx" ON "PasswordResetToken"("userId", "purpose");

-- CreateIndex
CREATE INDEX "PasswordHistory_userId_idx" ON "PasswordHistory"("userId");

-- CreateIndex
CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_key_windowStart_key" ON "RateLimitBucket"("key", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "Application_applicationNumber_key" ON "Application"("applicationNumber");

-- CreateIndex
CREATE INDEX "Application_borrowerUserId_idx" ON "Application"("borrowerUserId");

-- CreateIndex
CREATE INDEX "Application_workflowState_idx" ON "Application"("workflowState");

-- CreateIndex
CREATE INDEX "Application_workflowState_decidedAt_submittedAt_idx" ON "Application"("workflowState", "decidedAt", "submittedAt");

-- CreateIndex
CREATE INDEX "Application_priority_idx" ON "Application"("priority");

-- CreateIndex
CREATE INDEX "Application_isSeed_idx" ON "Application"("isSeed");

-- CreateIndex
CREATE INDEX "Application_updatedAt_idx" ON "Application"("updatedAt");

-- CreateIndex
CREATE INDEX "Application_copiedFromApplicationId_idx" ON "Application"("copiedFromApplicationId");

-- CreateIndex
CREATE INDEX "Borrower_ssnBlindIndex_idx" ON "Borrower"("ssnBlindIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Borrower_applicationId_ordinal_key" ON "Borrower"("applicationId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationData_applicationId_key" ON "ApplicationData"("applicationId");

-- CreateIndex
CREATE INDEX "ApplicationVersion_createdByUserId_idx" ON "ApplicationVersion"("createdByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationVersion_applicationId_versionNumber_key" ON "ApplicationVersion"("applicationId", "versionNumber");

-- CreateIndex
CREATE INDEX "Document_applicationId_status_idx" ON "Document"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Document_currentVersionId_idx" ON "Document"("currentVersionId");

-- CreateIndex
CREATE INDEX "Document_uploadedByUserId_idx" ON "Document"("uploadedByUserId");

-- CreateIndex
CREATE INDEX "Document_isSeed_idx" ON "Document"("isSeed");

-- CreateIndex
CREATE INDEX "DocumentVersion_uploadedByUserId_idx" ON "DocumentVersion"("uploadedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_documentId_versionNumber_key" ON "DocumentVersion"("documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "DocumentJob_status_startedAt_idx" ON "DocumentJob"("status", "startedAt");

-- CreateIndex
CREATE INDEX "DocumentJob_documentVersionId_idx" ON "DocumentJob"("documentVersionId");

-- CreateIndex
CREATE INDEX "OcrExtraction_documentVersionId_idx" ON "OcrExtraction"("documentVersionId");

-- CreateIndex
CREATE INDEX "DocumentRequest_applicationId_idx" ON "DocumentRequest"("applicationId");

-- CreateIndex
CREATE INDEX "DocumentRequest_requestedByUserId_idx" ON "DocumentRequest"("requestedByUserId");

-- CreateIndex
CREATE INDEX "DocumentRequest_fulfilledByDocumentId_idx" ON "DocumentRequest"("fulfilledByDocumentId");

-- CreateIndex
CREATE INDEX "Signature_applicationId_invalidatedAt_idx" ON "Signature"("applicationId", "invalidatedAt");

-- CreateIndex
CREATE INDEX "Signature_borrowerId_idx" ON "Signature"("borrowerId");

-- CreateIndex
CREATE INDEX "BankLink_applicationId_idx" ON "BankLink"("applicationId");

-- CreateIndex
CREATE INDEX "BankLink_borrowerId_idx" ON "BankLink"("borrowerId");

-- CreateIndex
CREATE INDEX "UnderwritingResult_applicationId_checkType_status_idx" ON "UnderwritingResult"("applicationId", "checkType", "status");

-- CreateIndex
CREATE INDEX "UnderwritingResult_requestedByUserId_idx" ON "UnderwritingResult"("requestedByUserId");

-- CreateIndex
CREATE INDEX "UnderwritingResult_supersededById_idx" ON "UnderwritingResult"("supersededById");

-- CreateIndex
CREATE INDEX "FraudFlag_applicationId_status_severity_idx" ON "FraudFlag"("applicationId", "status", "severity");

-- CreateIndex
CREATE INDEX "FraudFlag_sourceDocumentVersionId_idx" ON "FraudFlag"("sourceDocumentVersionId");

-- CreateIndex
CREATE INDEX "FraudFlag_sourceResultId_idx" ON "FraudFlag"("sourceResultId");

-- CreateIndex
CREATE INDEX "FraudFlag_resolvedByUserId_idx" ON "FraudFlag"("resolvedByUserId");

-- CreateIndex
CREATE INDEX "CaseworkerAssignment_applicationId_idx" ON "CaseworkerAssignment"("applicationId");

-- CreateIndex
CREATE INDEX "CaseworkerAssignment_caseworkerUserId_endedAt_idx" ON "CaseworkerAssignment"("caseworkerUserId", "endedAt");

-- CreateIndex
CREATE INDEX "CaseworkerAssignment_assignedByUserId_idx" ON "CaseworkerAssignment"("assignedByUserId");

-- CreateIndex
CREATE INDEX "ApprovalRecord_approverUserId_idx" ON "ApprovalRecord"("approverUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRecord_applicationId_versionNumber_level_key" ON "ApprovalRecord"("applicationId", "versionNumber", "level");

-- CreateIndex
CREATE INDEX "Condition_applicationId_status_idx" ON "Condition"("applicationId", "status");

-- CreateIndex
CREATE INDEX "Condition_approvalRecordId_idx" ON "Condition"("approvalRecordId");

-- CreateIndex
CREATE INDEX "Condition_clearedByUserId_idx" ON "Condition"("clearedByUserId");

-- CreateIndex
CREATE INDEX "WorkflowHistory_applicationId_createdAt_idx" ON "WorkflowHistory"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkflowHistory_actorUserId_idx" ON "WorkflowHistory"("actorUserId");

-- CreateIndex
CREATE INDEX "ApplicationNote_applicationId_type_createdAt_idx" ON "ApplicationNote"("applicationId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ApplicationNote_authorUserId_idx" ON "ApplicationNote"("authorUserId");

-- CreateIndex
CREATE INDEX "ApplicationNote_relatedTransitionId_idx" ON "ApplicationNote"("relatedTransitionId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_timestamp_idx" ON "AuditLogEntry"("timestamp");

-- CreateIndex
CREATE INDEX "AuditLogEntry_applicationId_idx" ON "AuditLogEntry"("applicationId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_actorUserId_idx" ON "AuditLogEntry"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditLogEntry_actionType_idx" ON "AuditLogEntry"("actionType");

-- CreateIndex
CREATE INDEX "AuditLogEntry_isSeed_idx" ON "AuditLogEntry"("isSeed");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_readAt_idx" ON "Notification"("recipientUserId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_deliveryStatus_createdAt_idx" ON "Notification"("deliveryStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_applicationId_idx" ON "Notification"("applicationId");

-- CreateIndex
CREATE INDEX "OutboundMessage_notificationId_idx" ON "OutboundMessage"("notificationId");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_createdAt_idx" ON "OutboundMessage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemConfig_key_key" ON "SystemConfig"("key");

-- CreateIndex
CREATE INDEX "SystemConfig_updatedByUserId_idx" ON "SystemConfig"("updatedByUserId");

-- CreateIndex
CREATE INDEX "SeedRun_createdByUserId_idx" ON "SeedRun"("createdByUserId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MfaEnrollment" ADD CONSTRAINT "MfaEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordHistory" ADD CONSTRAINT "PasswordHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_borrowerUserId_fkey" FOREIGN KEY ("borrowerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_copiedFromApplicationId_fkey" FOREIGN KEY ("copiedFromApplicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Borrower" ADD CONSTRAINT "Borrower_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationData" ADD CONSTRAINT "ApplicationData_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationVersion" ADD CONSTRAINT "ApplicationVersion_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationVersion" ADD CONSTRAINT "ApplicationVersion_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentJob" ADD CONSTRAINT "DocumentJob_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OcrExtraction" ADD CONSTRAINT "OcrExtraction_documentVersionId_fkey" FOREIGN KEY ("documentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_fulfilledByDocumentId_fkey" FOREIGN KEY ("fulfilledByDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLink" ADD CONSTRAINT "BankLink_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankLink" ADD CONSTRAINT "BankLink_borrowerId_fkey" FOREIGN KEY ("borrowerId") REFERENCES "Borrower"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnderwritingResult" ADD CONSTRAINT "UnderwritingResult_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnderwritingResult" ADD CONSTRAINT "UnderwritingResult_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnderwritingResult" ADD CONSTRAINT "UnderwritingResult_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "UnderwritingResult"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_sourceDocumentVersionId_fkey" FOREIGN KEY ("sourceDocumentVersionId") REFERENCES "DocumentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_sourceResultId_fkey" FOREIGN KEY ("sourceResultId") REFERENCES "UnderwritingResult"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudFlag" ADD CONSTRAINT "FraudFlag_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseworkerAssignment" ADD CONSTRAINT "CaseworkerAssignment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseworkerAssignment" ADD CONSTRAINT "CaseworkerAssignment_caseworkerUserId_fkey" FOREIGN KEY ("caseworkerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseworkerAssignment" ADD CONSTRAINT "CaseworkerAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRecord" ADD CONSTRAINT "ApprovalRecord_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRecord" ADD CONSTRAINT "ApprovalRecord_approverUserId_fkey" FOREIGN KEY ("approverUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_approvalRecordId_fkey" FOREIGN KEY ("approvalRecordId") REFERENCES "ApprovalRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Condition" ADD CONSTRAINT "Condition_clearedByUserId_fkey" FOREIGN KEY ("clearedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowHistory" ADD CONSTRAINT "WorkflowHistory_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowHistory" ADD CONSTRAINT "WorkflowHistory_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationNote" ADD CONSTRAINT "ApplicationNote_relatedTransitionId_fkey" FOREIGN KEY ("relatedTransitionId") REFERENCES "WorkflowHistory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SystemConfig" ADD CONSTRAINT "SystemConfig_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedRun" ADD CONSTRAINT "SeedRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- Hand-authored DB-level invariants (task-001) — constraints Prisma cannot express.
-- ===========================================================================

-- INV-013: no two User rows may share an email, compared case-insensitively.
CREATE UNIQUE INDEX "User_email_lower_key" ON "User" (lower("email"));

-- INV-014: sequence backing race-safe MM-YYYY-NNNNNN applicationNumber generation.
-- The MM-YYYY-NNNNNN format itself is applied in app code; the column is UNIQUE at DB level
-- (Application_applicationNumber_key above).
CREATE SEQUENCE "application_number_seq";

-- INV-015: at most one CaseworkerAssignment row per application with endedAt null,
-- under any concurrency.
CREATE UNIQUE INDEX "CaseworkerAssignment_applicationId_active_key"
  ON "CaseworkerAssignment" ("applicationId")
  WHERE "endedAt" IS NULL;

-- INV-016: a borrower must never have two applications simultaneously in active
-- states (2-13) — every state except draft, withdrawn, declined_by_borrower.
CREATE UNIQUE INDEX "Application_borrowerUserId_active_key"
  ON "Application" ("borrowerUserId")
  WHERE "workflowState" IN (
    'application_received',
    'completeness_validated',
    'documents_received',
    'aus_executed',
    'preliminary_decision',
    'escalated_review',
    'conditional_approval',
    'approved',
    'denied',
    'borrower_notified',
    'revision_requested',
    'suspended'
  );

-- INV-035: ordinal is 1 (primary) or 2 (co-borrower).
-- (Unique (applicationId, ordinal) is Borrower_applicationId_ordinal_key above.)
ALTER TABLE "Borrower"
  ADD CONSTRAINT "Borrower_ordinal_check" CHECK ("ordinal" IN (1, 2));

-- INV-025: loan term must be one of {120, 180, 240, 360} months (loan is a JSON document).
ALTER TABLE "ApplicationData"
  ADD CONSTRAINT "ApplicationData_loanTermMonths_check" CHECK (
    "loan" IS NULL
    OR "loan"->>'loanTermMonths' IS NULL
    OR ("loan"->>'loanTermMonths')::int IN (120, 180, 240, 360)
  );

-- ApprovalRecord.level is 1 or 2 (requirements §9).
ALTER TABLE "ApprovalRecord"
  ADD CONSTRAINT "ApprovalRecord_level_check" CHECK ("level" IN (1, 2));

-- ---------------------------------------------------------------------------
-- Verbatim contract enum values for hyphenated enums stored as TEXT
-- (Prisma enum identifiers cannot contain hyphens; CHECKs keep the DB values
-- exactly equal to the contracts.json literals).
-- ---------------------------------------------------------------------------

-- Citizenship
ALTER TABLE "Borrower"
  ADD CONSTRAINT "Borrower_citizenship_check" CHECK (
    "citizenship" IS NULL OR "citizenship" IN (
      'us-citizen', 'permanent-resident-alien', 'non-permanent-resident-alien'
    )
  );

-- HousingStatus
ALTER TABLE "Borrower"
  ADD CONSTRAINT "Borrower_housingStatus_check" CHECK (
    "housingStatus" IS NULL OR "housingStatus" IN (
      'own', 'rent', 'no-primary-housing-expense'
    )
  );

-- EmploymentType
ALTER TABLE "Borrower"
  ADD CONSTRAINT "Borrower_employmentType_check" CHECK (
    "employmentType" IS NULL OR "employmentType" IN (
      'employed', 'self-employed', 'retired', 'not-employed'
    )
  );

-- DocumentType (Document)
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_documentType_check" CHECK (
    "documentType" IN (
      'w2', 'pay-stub', 'bank-statement', 'tax-return-1040', 'government-id',
      'gift-letter', 'purchase-agreement', 'homeowners-insurance-quote', 'other'
    )
  );

-- DocumentType (DocumentRequest)
ALTER TABLE "DocumentRequest"
  ADD CONSTRAINT "DocumentRequest_documentType_check" CHECK (
    "documentType" IN (
      'w2', 'pay-stub', 'bank-statement', 'tax-return-1040', 'government-id',
      'gift-letter', 'purchase-agreement', 'homeowners-insurance-quote', 'other'
    )
  );

-- FraudFlagType
ALTER TABLE "FraudFlag"
  ADD CONSTRAINT "FraudFlag_type_check" CHECK (
    "type" IN (
      'ocr-mismatch', 'income-variance', 'avm-low', 'duplicate-ssn', 'employer-unverified'
    )
  );

-- NotificationChannel
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_channel_check" CHECK (
    "channel" IN ('in-app', 'email', 'sms')
  );

-- VersionReason
ALTER TABLE "ApplicationVersion"
  ADD CONSTRAINT "ApplicationVersion_reason_check" CHECK (
    "reason" IN ('initial-submission', 'resubmission')
  );

-- DenialReason (array elements)
ALTER TABLE "ApprovalRecord"
  ADD CONSTRAINT "ApprovalRecord_denialReasons_check" CHECK (
    "denialReasons" <@ ARRAY[
      'dti', 'employment-history', 'credit-history', 'collateral',
      'insufficient-cash', 'unverifiable-information', 'application-incomplete',
      'mortgage-insurance-denied', 'other'
    ]::text[]
  );

-- PasswordResetToken.purpose (no contract enum; values per requirements §9).
ALTER TABLE "PasswordResetToken"
  ADD CONSTRAINT "PasswordResetToken_purpose_check" CHECK (
    "purpose" IN ('reset', 'verify-email', 'invite')
  );
