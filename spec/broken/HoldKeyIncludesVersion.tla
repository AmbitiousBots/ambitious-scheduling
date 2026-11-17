---- MODULE HoldKeyIncludesVersion ----
EXTENDS Naturals, FiniteSets

CONSTANTS Blocks, MaxVersion

VARIABLES version, current, recorded, live

vars == <<version, current, recorded, live>>

Keys == Blocks \X (0..MaxVersion)

KeyOf(b, v) == <<b, v>>

BlockOf(k) == k[1]

CurrentKeys == {KeyOf(b, version) : b \in current}

ProposedCreates == {k \in CurrentKeys : recorded[k] # "created"}

ProposedKeeps == {k \in CurrentKeys : recorded[k] = "created"}

ProposedCancels == {k \in Keys : recorded[k] = "created" /\ k \notin CurrentKeys}

Init ==
    /\ version = 0
    /\ current = {}
    /\ recorded = [k \in Keys |-> "none"]
    /\ live = [b \in Blocks |-> 0]

CommitVersion(blocks) ==
    /\ version < MaxVersion
    /\ version' = version + 1
    /\ current' = blocks
    /\ UNCHANGED <<recorded, live>>

CreateAndRecord(k) ==
    /\ k \in ProposedCreates
    /\ live' = [live EXCEPT ![BlockOf(k)] = @ + 1]
    /\ recorded' = [recorded EXCEPT ![k] = "created"]
    /\ UNCHANGED <<version, current>>

CancelAndRecord(k) ==
    /\ k \in ProposedCancels
    /\ live' = [live EXCEPT ![BlockOf(k)] = @ - 1]
    /\ recorded' = [recorded EXCEPT ![k] = "canceled"]
    /\ UNCHANGED <<version, current>>

AskAgain ==
    /\ UNCHANGED vars

Next ==
    \/ \E blocks \in SUBSET Blocks : CommitVersion(blocks)
    \/ \E k \in Keys : CreateAndRecord(k) \/ CancelAndRecord(k)
    \/ AskAgain

Spec == Init /\ [][Next]_vars

CreatedKeys(b) == {k \in Keys : BlockOf(k) = b /\ recorded[k] = "created"}

RecordMatchesCalendar == \A b \in Blocks : live[b] = Cardinality(CreatedKeys(b))

NeverCreatedTwice == \A b \in Blocks : live[b] <= 1

KeptIsNeverProposedAgain == ProposedCreates \cap ProposedKeeps = {}

DroppedIsProposedForCancel == \A b \in Blocks : (live[b] > 0 /\ b \notin current) => \E k \in ProposedCancels : BlockOf(k) = b
=============================================================================
