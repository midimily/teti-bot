import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStructuredMemoryAgentQuality } from "./result-quality.ts";

test("Structured Memory Agent quality gate requires task fidelity and approved reference coverage", () => {
  assert.deepEqual(evaluateStructuredMemoryAgentQuality({
    schemaVersion: 1,
    expectedReferenceCount: 5,
    correctlyUsedReferenceCount: 4,
    currentTaskSatisfied: true,
    contradictionDetected: false,
    unapprovedReferenceDetected: false,
    instructionBoundaryViolated: false
  }), {
    schemaVersion: 1,
    score: 88,
    referenceCoverage: 0.8,
    passed: true,
    failureCodes: []
  });

  const unsafe = evaluateStructuredMemoryAgentQuality({
    schemaVersion: 1,
    expectedReferenceCount: 5,
    correctlyUsedReferenceCount: 5,
    currentTaskSatisfied: true,
    contradictionDetected: false,
    unapprovedReferenceDetected: true,
    instructionBoundaryViolated: true
  });
  assert.equal(unsafe.passed, false);
  assert.deepEqual(unsafe.failureCodes, [
    "UNAPPROVED_REFERENCE_USED",
    "REFERENCE_TREATED_AS_INSTRUCTION"
  ]);
  assert.equal(JSON.stringify(unsafe).includes("memoryId"), false);
});
