---- MODULE CommitIgnoresBase ----
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Writers, MaxTasks

VARIABLES history, tasks, phase, base, seen, receipt, clone

vars == <<history, tasks, phase, base, seen, receipt, clone>>

Init ==
    /\ history = <<>>
    /\ tasks = 0
    /\ phase = [w \in Writers |-> "idle"]
    /\ base = [w \in Writers |-> 0]
    /\ seen = [w \in Writers |-> 0]
    /\ receipt = [w \in Writers |-> 0]
    /\ clone = <<>>

Propose(w) ==
    /\ phase[w] = "idle"
    /\ base' = [base EXCEPT ![w] = Len(history)]
    /\ seen' = [seen EXCEPT ![w] = tasks]
    /\ phase' = [phase EXCEPT ![w] = "proposed"]
    /\ UNCHANGED <<history, tasks, receipt, clone>>

EditTask ==
    /\ tasks < MaxTasks
    /\ tasks' = tasks + 1
    /\ UNCHANGED <<history, phase, base, seen, receipt, clone>>

RefuseStale(w) ==
    /\ phase[w] = "proposed"
    /\ base[w] # Len(history)
    /\ phase' = [phase EXCEPT ![w] = "stale"]
    /\ UNCHANGED <<history, tasks, base, seen, receipt, clone>>

RefuseTasksChanged(w) ==
    /\ phase[w] = "proposed"
    /\ base[w] = Len(history)
    /\ seen[w] # tasks
    /\ phase' = [phase EXCEPT ![w] = "tasks_changed"]
    /\ UNCHANGED <<history, tasks, base, seen, receipt, clone>>

Commit(w) ==
    /\ phase[w] = "proposed"
    /\ seen[w] = tasks
    /\ history' = Append(history, [by |-> w, base |-> base[w], proposedFor |-> seen[w], tasksAtCommit |-> tasks])
    /\ receipt' = [receipt EXCEPT ![w] = Len(history) + 1]
    /\ phase' = [phase EXCEPT ![w] = "committed"]
    /\ UNCHANGED <<tasks, base, seen, clone>>

Retry(w) ==
    /\ phase[w] = "committed"
    /\ receipt[w] # 0
    /\ UNCHANGED vars

ProposeAgain(w) ==
    /\ phase[w] \in {"stale", "tasks_changed"}
    /\ phase' = [phase EXCEPT ![w] = "idle"]
    /\ UNCHANGED <<history, tasks, base, seen, receipt, clone>>

Clone ==
    /\ clone = <<>>
    /\ Len(history) > 0
    /\ clone' = history
    /\ UNCHANGED <<history, tasks, phase, base, seen, receipt>>

Next ==
    \/ \E w \in Writers : Propose(w) \/ RefuseStale(w) \/ RefuseTasksChanged(w) \/ Commit(w) \/ Retry(w) \/ ProposeAgain(w)
    \/ EditTask
    \/ Clone

Spec == Init /\ [][Next]_vars

Bounded == Len(history) <= Cardinality(Writers) + 1

NoLostUpdate == \A i \in 1..Len(history) : history[i].base = i - 1

CommittedForCurrentTasks == \A i \in 1..Len(history) : history[i].proposedFor = history[i].tasksAtCommit

ReceiptNamesOwnVersion == \A w \in Writers : receipt[w] # 0 => (receipt[w] <= Len(history) /\ history[receipt[w]].by = w)

OneVersionPerApproval == \A i, j \in 1..Len(history) : history[i].by = history[j].by => i = j

CloneLeavesSourceAlone == Len(clone) <= Len(history) /\ SubSeq(history, 1, Len(clone)) = clone
=============================================================================
