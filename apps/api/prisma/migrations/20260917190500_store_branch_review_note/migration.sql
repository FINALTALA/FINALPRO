-- Sprint 3 follow-up: FR-VEND-003's "request resubmission" decision
-- needs to communicate why to the vendor - see StoreBranch.reviewNote's
-- schema comment.

-- AlterTable
ALTER TABLE "store_branches" ADD COLUMN "reviewNote" TEXT;
