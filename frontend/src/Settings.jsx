import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, fmtGpa, letterClass } from "./api";
import { PassFailScaleEditor, ScaleRowsEditor, scalesMatch } from "./ScaleEditor.jsx";
import {
  CREDIT_LABEL_OPTIONS,
  TERM_LABEL_OPTIONS,
  DEFAULT_COLORS,
  GRADE_SCALES,
  MAX_CUSTOM_PRESETS,
  THEME_PRESETS,
  appearanceFromThemePreset,
  getActiveGradeColors,
  getGradeScale,
  themePresetFromAppearance,
} from "./theme";
import { Tooltip, useCreditTerms, useShowScore } from "./creditLabel.jsx";
import { FALLBACK_COLORS, FlagIcon, newFlagId, normalizeFlags } from "./flags.jsx";
import { useToasts } from "./notifications.jsx";

const TARGETS = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-"];
const COLLEGE_TERM_SEQUENCE = ["fall", "summer", "spring", "winter"];

function normalizedName(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function sortWeightTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag, index) => ({ tag, index }))
    .sort((a, b) => {
      const aBoost = Number(a.tag?.boost);
      const bBoost = Number(b.tag?.boost);
      const aValue = Number.isFinite(aBoost) ? aBoost : 0;
      const bValue = Number.isFinite(bBoost) ? bBoost : 0;
      return aValue - bValue || a.index - b.index;
    })
    .map(({ tag }) => tag);
}

const RESERVED_TERM_NAMES = new Set(["settings", "overall"]);

function collegeTermKey(year, season) {
  return `${Number(year)}:${season}`;
}

function highSchoolPeriodKey(semester) {
  const year = Number(semester?.year) || 0;
  return String(["spring", "summer"].includes(String(semester?.season || "").toLowerCase()) ? year - 1 : year);
}

const COLOR_FIELDS = [
  ["primary", "Primary"],
  ["secondary", "Secondary"],
  ["tertiary", "Tertiary"],
];

const PREVIEW_LETTERS = [
  ["A+", "ap"],
  ["A", "a"],
  ["A-", "am"],
  ["B+", "bp"],
  ["B", "b"],
  ["C", "c"],
];

const CUSTOM_LETTERS = [
  ["A+", "ap"],
  ["A", "a"],
  ["A−", "am"],
  ["B+", "bp"],
  ["B", "b"],
  ["B−", "bm"],
  ["C+", "cp"],
  ["C", "c"],
  ["C−", "cm"],
  ["D+", "dp"],
  ["D", "d"],
  ["D−", "dm"],
  ["F", "f"],
];

const SETUP_APPEARANCE_FIELDS = [
  "weightedGpa",
  "wgpaInSidebar",
  "showScore",
  "classType",
  "termLabelId",
  "termLabelCustom",
  "creditLabelId",
  "creditLabelCustom",
  "semesterTitles",
  "highSchoolTerms",
  "highSchoolTermsByPeriod",
  "highSchoolAcademicPeriods",
  "highSchoolAcademicPeriodOrder",
];

function setupAppearancePayload(appearance) {
  return Object.fromEntries(
    SETUP_APPEARANCE_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(appearance || {}, field))
      .map((field) => [field, appearance[field]])
  );
}

function setupTermLeaves(term) {
  const classes = Array.isArray(term?.classes) ? term.classes : [];
  return classes.length
    ? classes.map((course) => `course:${course.id}`)
    : [`term:${term?.id}`];
}

function sortSetupClasses(classes) {
  return [...(Array.isArray(classes) ? classes : [])].sort((a, b) => {
    const aName = String(a?.name || a?.code || "").trim();
    const bName = String(b?.name || b?.code || "").trim();
    return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: "base" })
      || Number(a?.id || 0) - Number(b?.id || 0);
  });
}

function setupPeriodLeaves(period) {
  return (period?.terms || []).flatMap(setupTermLeaves);
}

function setupBookLeaves(gradebook) {
  return (gradebook?.periods || []).flatMap(setupPeriodLeaves);
}

function uniqueImportedGradebookName(name, usedNames) {
  const base = String(name || "Imported gradebook").trim() || "Imported gradebook";
  if (!usedNames.has(normalizedName(base))) {
    usedNames.add(normalizedName(base));
    return base;
  }
  let candidate = `${base} (copy)`;
  let copyNumber = 2;
  while (usedNames.has(normalizedName(candidate))) {
    candidate = `${base} (copy ${copyNumber})`;
    copyNumber += 1;
  }
  usedNames.add(normalizedName(candidate));
  return candidate;
}

function setupSelectionState(leaves, selected) {
  const count = leaves.filter((leaf) => selected.has(leaf)).length;
  return { checked: leaves.length > 0 && count === leaves.length, partial: count > 0 && count < leaves.length };
}

function SetupCheckbox({ leaves, selected, onToggle, label }) {
  const ref = useRef(null);
  const { checked, partial } = setupSelectionState(leaves, selected);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-checked={partial ? "mixed" : checked}
      aria-label={label}
      onChange={(event) => onToggle(leaves, event.target.checked)}
    />
  );
}

function safeSetupFilename(value) {
  const name = String(value || "gradebook-setups")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");
  return `${name || "gradebook-setups"}${name.endsWith(".json") ? "" : ".json"}`;
}

function importPlanFor(payload, gradebooks) {
  let nextNumber = gradebooks.reduce((highest, gradebook) => {
    const match = String(gradebook.id).match(/^gradebook-(\d+)$/);
    return Math.max(highest, match ? Number(match[1]) : 0);
  }, 0) + 1;
  const usedIds = new Set(gradebooks.map((gradebook) => String(gradebook.id)));
  const nextId = () => {
    while (usedIds.has(`gradebook-${nextNumber}`)) nextNumber += 1;
    const id = `gradebook-${nextNumber}`;
    usedIds.add(id);
    nextNumber += 1;
    return id;
  };
  return (payload?.gradebooks || []).filter((gradebook) => gradebook && typeof gradebook === "object").map((gradebook, index) => ({
      source_id: String(gradebook.source_id || gradebook.name || index),
      destination_mode: "unplaced",
      destination_id: nextId(),
      destination_name: String(gradebook.name || `Imported gradebook ${index + 1}`),
      apply_settings: false,
      conflict_strategy: "copy",
      term_destinations: {},
      period_destinations: {},
      class_destinations: {},
      explicit_term_destinations: {},
    }));
}

function GradebookSetupTransfer({ gradebooks, gradebookAppearances, onImportComplete }) {
  const { push, warning } = useToasts();
  const [inventory, setInventory] = useState([]);
  const [inventoryError, setInventoryError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [filename, setFilename] = useState("gradebook-setups");
  const [includeEnteredAssignments, setIncludeEnteredAssignments] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [importPayload, setImportPayload] = useState(null);
  const [importPlan, setImportPlan] = useState([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.gradebookSetupInventory(gradebooks)
      .then((result) => {
        if (cancelled) return;
        const next = Array.isArray(result?.gradebooks) ? result.gradebooks : [];
        setInventory(next);
        setSelected(new Set(next.flatMap(setupBookLeaves)));
        setInventoryError("");
      })
      .catch((err) => {
        if (!cancelled) setInventoryError(err.message);
      });
    return () => { cancelled = true; };
  }, [gradebooks]);

  function toggleLeaves(leaves, shouldSelect) {
    setSelected((current) => {
      const next = new Set(current);
      leaves.forEach((leaf) => (shouldSelect ? next.add(leaf) : next.delete(leaf)));
      return next;
    });
  }

  async function exportSetups() {
    const selections = inventory.map((gradebook) => {
      const termIds = [];
      const courseIds = [];
      const termNames = {};
      (gradebook.periods || []).forEach((period) => (period.terms || []).forEach((term) => {
        const courseLeaves = (term.classes || []).filter((course) => selected.has(`course:${course.id}`));
        if (courseLeaves.length || selected.has(`term:${term.id}`)) {
          termIds.push(term.id);
          termNames[term.id] = term.name;
        }
        courseLeaves.forEach((course) => courseIds.push(course.id));
      }));
      return {
        id: gradebook.id,
        name: gradebook.name,
        term_ids: termIds,
        course_ids: courseIds,
        term_names: termNames,
        appearance: setupAppearancePayload(gradebookAppearances?.[gradebook.id]),
      };
    }).filter((item) => item.term_ids.length || item.course_ids.length);
    if (!selections.length) {
      warning("Choose at least one class or empty term to export.");
      return;
    }
    setExportBusy(true);
    try {
      const payload = await api.exportGradebookSetups(selections, includeEnteredAssignments);
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const download = document.createElement("a");
      download.href = url;
      download.download = safeSetupFilename(filename);
      document.body.appendChild(download);
      download.click();
      download.remove();
      URL.revokeObjectURL(url);
      push({ type: "timed", message: "Gradebook setup exported", durationMs: 3000 });
    } catch (err) {
      warning(err.message);
    } finally {
      setExportBusy(false);
    }
  }

  function readImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || ""));
        if (payload?.format !== "grade-calculator-gradebook-setup" || !Array.isArray(payload?.gradebooks)) {
          throw new Error("Choose a Grade Calculator gradebook setup file.");
        }
        setImportPayload(payload);
        setImportPlan(importPlanFor(payload, gradebooks));
        setImportMessage("");
      } catch (err) {
        warning(err.message || "Could not read that setup file.");
      }
    };
    reader.readAsText(file);
  }

  function updatePlan(sourceId, updater) {
    setImportPlan((current) => current.map((entry) => entry.source_id === sourceId ? updater(entry) : entry));
  }

  function sourceTermName(term) {
    return String(term?.name || term?.season || "Term");
  }

  function fullGradebookPlacement(sourceId) {
    const sourceBook = (importPayload?.gradebooks || []).find((gradebook, index) => (
      String(gradebook.source_id || gradebook.name || index) === String(sourceId)
    ));
    const term_destinations = {};
    const period_destinations = {};
    (sourceBook?.periods || []).forEach((period) => {
      if (period?.key) period_destinations[period.key] = "new";
      (period?.terms || []).forEach((term) => {
        if (term?.key) term_destinations[term.key] = "new";
      });
    });
    return { term_destinations, period_destinations };
  }

  function startPlacementDrag(event, payload) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-gradebook-placement", JSON.stringify(payload));
    event.dataTransfer.setData("text/plain", payload.type);
  }

  function allowPlacementDrop(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }

  function resetDroppedClass(event) {
    event.preventDefault();
    let dragged;
    try {
      dragged = JSON.parse(event.dataTransfer.getData("application/x-gradebook-placement"));
    } catch {
      return;
    }
    if (!dragged?.sourceId || !["class", "term", "period"].includes(dragged.type)) return;
    updatePlan(dragged.sourceId, (current) => {
      if (dragged.type === "term") {
        const term_destinations = { ...current.term_destinations };
        const explicit_term_destinations = { ...current.explicit_term_destinations };
        delete term_destinations[dragged.termKey];
        delete explicit_term_destinations[dragged.termKey];
        const next = { ...current, term_destinations, explicit_term_destinations };
        return Object.keys(term_destinations).length || Object.keys(current.period_destinations).length || Object.keys(current.class_destinations).length
          ? next
          : { ...next, destination_mode: "unplaced", apply_settings: false };
      }
      if (dragged.type === "period") {
        const period_destinations = { ...current.period_destinations };
        delete period_destinations[dragged.periodKey];
        const next = { ...current, period_destinations };
        return Object.keys(current.term_destinations).length || Object.keys(period_destinations).length || Object.keys(current.class_destinations).length
          ? next
          : { ...next, destination_mode: "unplaced", apply_settings: false };
      }
      if (!dragged.classKey) return current;
      const class_destinations = { ...current.class_destinations };
      delete class_destinations[dragged.classKey];
      const next = { ...current, class_destinations };
      return Object.keys(current.term_destinations).length || Object.keys(current.period_destinations).length || Object.keys(class_destinations).length
        ? next
        : { ...next, destination_mode: "unplaced", apply_settings: false };
    });
  }

  function placedClassesForTerm(gradebookId, termId) {
    return (importPayload?.gradebooks || []).flatMap((sourceBook, index) => {
      const sourceId = String(sourceBook.source_id || sourceBook.name || index);
      const entry = importPlan.find((item) => item.source_id === sourceId);
      if (String(entry?.destination_id) !== String(gradebookId)) return [];
      const sourceType = sourceBook.settings?.gradebook_type === "high_school" ? "high_school" : "college";
      return (sourceBook.periods || []).flatMap((period) => (period.terms || []).flatMap((term) =>
        sortSetupClasses((term.classes || []).filter((course) => String(entry?.class_destinations?.[course.key]) === String(termId))).map((course) => ({
          sourceId,
          sourceType,
          classKey: course.key,
          className: course.code,
        }))
      ));
    });
  }

  function placedClassesForPeriod(gradebookId, periodId) {
    return (importPayload?.gradebooks || []).flatMap((sourceBook, index) => {
      const sourceId = String(sourceBook.source_id || sourceBook.name || index);
      const entry = importPlan.find((item) => item.source_id === sourceId);
      if (String(entry?.destination_id) !== String(gradebookId)) return [];
      const sourceType = sourceBook.settings?.gradebook_type === "high_school" ? "high_school" : "college";
      return (sourceBook.periods || []).flatMap((period) => (period.terms || []).flatMap((term) =>
        sortSetupClasses((term.classes || []).filter((course) => String(entry?.class_destinations?.[course.key]) === `period:${periodId}`)).map((course) => ({
          sourceId,
          sourceType,
          classKey: course.key,
          className: course.code,
        }))
      ));
    });
  }

  function placedTermsForBook(gradebookId) {
    return (importPayload?.gradebooks || []).flatMap((sourceBook, index) => {
      const sourceId = String(sourceBook.source_id || sourceBook.name || index);
      const entry = importPlan.find((item) => item.source_id === sourceId);
      if (String(entry?.destination_id) !== String(gradebookId)) return [];
      const sourceType = sourceBook.settings?.gradebook_type === "high_school" ? "high_school" : "college";
      return (sourceBook.periods || []).flatMap((period) => (period.terms || [])
        .filter((term) => Object.prototype.hasOwnProperty.call(entry?.explicit_term_destinations || {}, term.key))
        .map((term) => ({ sourceId, sourceType, key: term.key, name: sourceTermName(term), classes: sortSetupClasses(term.classes) }))
      );
    });
  }

  function applyDroppedPlacement(dragged, target) {
    if (target.type === "new-gradebook") {
      if (dragged.type !== "gradebook") {
        warning("Drop a full gradebook here to create a new gradebook.");
        return;
      }
      const { term_destinations, period_destinations } = fullGradebookPlacement(dragged.sourceId);
      updatePlan(dragged.sourceId, (current) => ({
        ...current,
        destination_mode: "new",
        destination_name: dragged.gradebookName || current.destination_name,
        apply_settings: true,
        term_destinations,
        period_destinations,
        class_destinations: {},
        explicit_term_destinations: {},
      }));
      return;
    }
    if (dragged.type === "gradebook") {
      warning("Drop a full gradebook onto New gradebook. Drop an individual term, period, or class onto an existing gradebook.");
      return;
    }
    if (dragged.type !== "gradebook" && !target.type) return;
    if (dragged.type === "period" && target.type === "term") {
      warning("Drop an academic period on an academic period, or drop its individual terms into a destination term.");
      return;
    }
    if (dragged.type === "term" && target.type !== "gradebook") {
      warning("Drop a term onto the destination gradebook where it should be placed.");
      return;
    }
    if (dragged.type === "class" && target.type !== "term" && !(target.type === "period" && target.gradebookType === "high_school")) {
      warning("Drop a class onto a destination term, or onto an academic period in a multi-term gradebook.");
      return;
    }
    if (dragged.type === "period" && target.type !== "period") {
      warning("Drop an academic period onto a destination academic period.");
      return;
    }
    updatePlan(dragged.sourceId, (current) => {
      const destinationChanged = current.destination_mode !== "existing"
        || String(current.destination_id) !== String(target.gradebookId);
      const base = destinationChanged
        ? {
          ...current,
          term_destinations: {},
          period_destinations: {},
          class_destinations: {},
          explicit_term_destinations: {},
        }
        : current;
      const next = {
        ...base,
        destination_mode: "existing",
        destination_id: String(target.gradebookId),
        destination_name: target.gradebookName || current.destination_name,
        apply_settings: false,
      };
      if (dragged.type === "period") {
        next.period_destinations = { ...current.period_destinations, [dragged.periodKey]: String(target.periodId) };
      }
      if (dragged.type === "term") {
        const matchingTerm = (inventory.find((book) => String(book.id) === String(target.gradebookId))?.periods || [])
          .flatMap((period) => period.terms || [])
          .find((term) => normalizedName(term.name) === normalizedName(dragged.termName));
        next.term_destinations = {
          ...current.term_destinations,
          [dragged.termKey]: matchingTerm ? String(matchingTerm.id) : "new",
        };
        next.explicit_term_destinations = { ...current.explicit_term_destinations, [dragged.termKey]: true };
      }
      if (dragged.type === "class") {
        next.class_destinations = { ...current.class_destinations, [dragged.classKey]: target.type === "period" ? `period:${target.periodId}` : String(target.termId) };
      }
      return next;
    });
  }

  function placeDroppedItem(event, target) {
    event.preventDefault();
    let dragged;
    try {
      dragged = JSON.parse(event.dataTransfer.getData("application/x-gradebook-placement"));
    } catch {
      return;
    }
    if (!dragged?.sourceId || !target) return;
    if (target.type === "new-gradebook") {
      applyDroppedPlacement(dragged, target);
      return;
    }
    if (!target.gradebookId) return;
    if (dragged.gradebookType === target.gradebookType) {
      applyDroppedPlacement(dragged, target);
      return;
    }
    if (dragged.type !== "class" || (target.type !== "term" && !(target.type === "period" && target.gradebookType === "high_school"))) {
      warning("Gradebooks of different types can only share an individual class. Drop the class onto a destination term, or onto an academic period in a multi-term gradebook.");
      return;
    }
    const sourceLabel = dragged.gradebookType === "high_school" ? "Multi-term" : "Single-term";
    const targetLabel = target.gradebookType === "high_school" ? "Multi-term" : "Single-term";
    push({
      id: `convert-import-class-${dragged.sourceId}-${dragged.classKey}-${target.termId || target.periodId}`,
      type: "persistent",
      title: "Convert class type?",
      message: `Import ${dragged.className || "this class"} from a ${sourceLabel} gradebook into ${target.gradebookName}'s ${targetLabel} gradebook? Its setup will be converted for the selected destination.`,
      confirmLabel: "Convert class",
      dismissLabel: "Cancel",
      onConfirm: () => applyDroppedPlacement(dragged, target),
    });
  }

  function clearImportPreview() {
    if (importBusy) return;
    setImportPayload(null);
    setImportPlan([]);
    setImportMessage("");
  }

  async function importSetups() {
    if (!importPayload || !importPlan.length) return;
    const placedPlan = importPlan.filter((entry) => entry.destination_mode === "new" || entry.destination_mode === "existing");
    if (!placedPlan.length) {
      warning("Drag at least one imported gradebook, term, period, or class into the destination tree before importing.");
      return;
    }
    setImportBusy(true);
    try {
      // Resolve gradebook-name conflicts only when the import is saved so the
      // placement preview continues to show the source gradebook's name.
      const usedNames = new Set(gradebooks.map((gradebook) => normalizedName(gradebook.name)));
      const planToSave = placedPlan.map((entry) => (
        entry.destination_mode === "new"
          ? { ...entry, destination_name: uniqueImportedGradebookName(entry.destination_name, usedNames) }
          : entry
      ));
      const result = await api.importGradebookSetups(importPayload, planToSave);
      await onImportComplete?.(result);
      const imported = result?.gradebooks || [];
      const totalClasses = imported.reduce((sum, item) => sum + Number(item.imported_courses || 0), 0);
      const skipped = imported.reduce((sum, item) => sum + Number(item.skipped_courses || 0), 0);
      setImportMessage(`Imported ${imported.length} gradebook${imported.length === 1 ? "" : "s"} and ${totalClasses} class${totalClasses === 1 ? "" : "es"}${skipped ? `; skipped ${skipped} matching class${skipped === 1 ? "" : "es"}` : ""}.`);
      setImportPayload(null);
      setImportPlan([]);
    } catch (err) {
      warning(err.message);
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <section className="panel gradebook-transfer-panel" style={{ marginTop: 16 }}>
      <h2>Import & Export Gradebook Setups</h2>
      <p className="muted settings-note">Exports include gradebook setup, periods, terms, classes, category rules, and grade scales. Entered assignments and grades are optional; snapshots and global settings stay out of the file.</p>
      <div className="gradebook-transfer-columns">
        <div className="gradebook-transfer-export">
          <div className="transfer-heading-row">
            <h3>Export</h3>
            <span className="muted">Choose what to include</span>
          </div>
          {inventoryError ? <p className="error">{inventoryError}</p> : null}
          <div className="gradebook-export-options">
            <div className="gradebook-export-tree" aria-label="Gradebooks to export">
              {inventory.map((gradebook) => {
              const bookLeaves = setupBookLeaves(gradebook);
              const renderTerm = (term) => {
                const termLeaves = setupTermLeaves(term);
                return <details className="export-tree-term" key={term.id} open>
                  <summary>
                    <SetupCheckbox leaves={termLeaves} selected={selected} onToggle={toggleLeaves} label={`Select ${term.name}`} />
                    <span>{term.name}</span>
                  </summary>
                  {(term.classes || []).length ? <div className="export-tree-classes">
                    {sortSetupClasses(term.classes).map((course) => <label key={course.id}>
                      <SetupCheckbox leaves={[`course:${course.id}`]} selected={selected} onToggle={toggleLeaves} label={`Select ${course.name}`} />
                      <span>{course.name}</span>
                    </label>)}
                  </div> : <p className="muted export-empty-term">Empty term</p>}
                </details>;
              };
              return <details className="export-tree-gradebook" key={gradebook.id} open>
                <summary>
                  <SetupCheckbox leaves={bookLeaves} selected={selected} onToggle={toggleLeaves} label={`Select ${gradebook.name}`} />
                  <strong>{gradebook.name}</strong>
                  <span className="muted">{gradebook.gradebook_type === "high_school" ? "Multi-term" : "Single-term"}</span>
                </summary>
                {gradebook.gradebook_type === "high_school" ? (gradebook.periods || []).map((period) => {
                  const periodLeaves = setupPeriodLeaves(period);
                  return <details className="export-tree-period" key={period.key} open>
                    <summary>
                      <SetupCheckbox leaves={periodLeaves} selected={selected} onToggle={toggleLeaves} label={`Select ${period.name}`} />
                      <span>{period.name}</span>
                    </summary>
                    {(period.terms || []).map(renderTerm)}
                  </details>;
                }) : (gradebook.periods || []).flatMap((period) => period.terms || []).map(renderTerm)}
              </details>;
              })}
            </div>
            <div className="gradebook-export-option-panel">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={includeEnteredAssignments}
                  onChange={(event) => setIncludeEnteredAssignments(event.target.checked)}
                />
                <span>Include entered assignments and their grades</span>
              </label>
              <p className="muted">When enabled, selected classes include their assignment names, scores, comments, and grade overrides.</p>
            </div>
          </div>
          <div className="transfer-export-actions">
            <label className="muted">
              Export file name
              <input className="input" value={filename} onChange={(event) => setFilename(event.target.value)} aria-label="Export file name" />
            </label>
            <button className="btn primary" type="button" onClick={exportSetups} disabled={exportBusy || !inventory.length}>{exportBusy ? "Preparing…" : "Export setup"}</button>
          </div>
        </div>
        <div className="gradebook-transfer-import">
          <div className="transfer-heading-row"><h3>Import</h3><span className="muted">Place each item deliberately</span></div>
          <label className="btn transfer-file-button">
            <input type="file" accept="application/json,.json" onChange={readImportFile} />
            Choose setup file
          </label>
          {importMessage ? <p className="transfer-success">{importMessage}</p> : null}
          {importPayload ? <div className="gradebook-import-plan">
            <p className="muted">Drag a gradebook, academic period, term, or class from the file onto its destination. Moving an individual class between different gradebook types asks for confirmation; every drop creates an explicit placement rule.</p>
            <div className="import-placement-board">
              <section className="import-placement-tree import-source-tree" onDragOver={allowPlacementDrop} onDrop={resetDroppedClass}>
                <h4>From file</h4>
                {(importPayload.gradebooks || []).map((gradebook, index) => {
                  const sourceId = String(gradebook.source_id || gradebook.name || index);
                  const sourceType = gradebook.settings?.gradebook_type === "high_school" ? "high_school" : "college";
                  const sourceTerms = (gradebook.periods || []).flatMap((period) => period.terms || []);
                  const SourceTerm = ({ term }) => <details className="placement-source-term" key={term.key} open>
                    <summary draggable onDragStart={(event) => startPlacementDrag(event, { type: "term", sourceId, termKey: term.key, termName: sourceTermName(term), gradebookType: sourceType })}>
                      <span>{sourceTermName(term)}</span>
                      <small className="muted">{(term.classes || []).length} class{(term.classes || []).length === 1 ? "" : "es"}</small>
                    </summary>
                    <div className="placement-source-classes">
                      {sortSetupClasses(term.classes).map((course) => <div className="placement-source-class" key={course.key} draggable onDragStart={(event) => startPlacementDrag(event, { type: "class", sourceId, classKey: course.key, className: course.code, gradebookType: sourceType })}>{course.code}</div>)}
                      {(term.classes || []).length === 0 ? <small className="muted">Empty term</small> : null}
                    </div>
                  </details>;
                  return <details className="placement-source-book" key={sourceId} open>
                    <summary draggable onDragStart={(event) => startPlacementDrag(event, { type: "gradebook", sourceId, gradebookName: gradebook.name, gradebookType: sourceType })}>
                      <strong>{gradebook.name || "Imported gradebook"}</strong>
                    </summary>
                    {sourceType === "college" ? sourceTerms.map((term) => <SourceTerm key={term.key} term={term} />) : (gradebook.periods || []).map((period) => <details className="placement-source-period" key={period.key} open>
                      <summary draggable={sourceType === "high_school"} onDragStart={(event) => startPlacementDrag(event, { type: "period", sourceId, periodKey: period.key, gradebookType: sourceType })}>
                        <span>{period.name}</span>
                      </summary>
                      {(period.terms || []).map((term) => <SourceTerm key={term.key} term={term} />)}
                    </details>)}
                  </details>;
                })}
              </section>
              <section className="import-placement-tree import-target-tree">
                <h4>Existing gradebooks</h4>
                <div
                  className="placement-target-new-book"
                  onDragOver={allowPlacementDrop}
                  onDrop={(event) => placeDroppedItem(event, { type: "new-gradebook" })}
                >
                  <strong>New gradebook</strong>
                  <small className="muted">Drop a full gradebook here</small>
                </div>
                {(importPayload.gradebooks || []).map((sourceBook, index) => {
                  const sourceId = String(sourceBook.source_id || sourceBook.name || index);
                  const entry = importPlan.find((item) => item.source_id === sourceId);
                  if (entry?.destination_mode !== "new") return null;
                  const sourceType = sourceBook.settings?.gradebook_type === "high_school" ? "high_school" : "college";
                  return <div className="placement-target-imported-book" key={`new-${sourceId}`}>
                    <strong>{entry.destination_name || sourceBook.name || "Imported gradebook"}</strong>
                    <small>New gradebook · Added from file</small>
                    {(sourceBook.periods || []).flatMap((period) => (period.terms || []).map((term) => (
                      <div className="placement-target-imported-term" key={`${sourceId}-${term.key}`}>
                        <strong>{sourceType === "high_school" ? `${period.name} · ${sourceTermName(term)}` : sourceTermName(term)}</strong>
                        <small>Added from file</small>
                        {sortSetupClasses(term.classes).map((course) => <span key={course.key}>{course.code}</span>)}
                      </div>
                    )))}
                  </div>;
                })}
                {inventory.map((gradebook) => <details className="placement-target-book" key={gradebook.id} open>
                  <summary onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "gradebook", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type })}>
                    <strong>{gradebook.name}</strong><small className="muted">Drop a term here</small>
                  </summary>
                  {placedTermsForBook(gradebook.id).map((term) => <div className="placement-target-imported-term" key={`${term.sourceId}-${term.key}`} draggable onDragStart={(event) => startPlacementDrag(event, { type: "term", sourceId: term.sourceId, termKey: term.key, termName: term.name, gradebookType: term.sourceType })}>
                    <strong>{term.name}</strong><small>Added from file</small>
                    {sortSetupClasses(term.classes).map((course) => <span key={course.key}>{course.code}</span>)}
                   </div>)}
                  {gradebook.gradebook_type !== "high_school" ? (gradebook.periods || []).flatMap((period) => period.terms || []).map((term) => {
                    const placedClasses = placedClassesForTerm(gradebook.id, term.id);
                    return <div className="placement-target-term-group placement-target-direct-term" key={term.id}>
                      <div className="placement-target-term" onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "term", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type, termId: term.id })}>
                        <span>{term.name}</span><small className="muted">Drop a class here</small>
                      </div>
                      {placedClasses.map((course) => <div className="placement-target-imported-class" key={`${course.sourceId}-${course.classKey}`} draggable onDragStart={(event) => startPlacementDrag(event, { type: "class", sourceId: course.sourceId, classKey: course.classKey, className: course.className, gradebookType: course.sourceType })}>
                        <span>{course.className}</span><small>Added from file</small>
                      </div>)}
                    </div>;
                  }) : null}
                  {(gradebook.periods || []).map((period) => {
                    const periodId = period.key.replace("period-", "");
                    if (gradebook.gradebook_type !== "high_school") return null;
                    if (gradebook.gradebook_type === "high_school") {
                      const placedClasses = placedClassesForPeriod(gradebook.id, periodId);
                      const placedTermGroups = (period.terms || []).map((term) => {
                        const placedTermClasses = placedClassesForTerm(gradebook.id, term.id);
                        return <div className="placement-target-term-group" key={term.id}>
                          <div className="placement-target-term" onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "term", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type, termId: term.id })}>
                            <span>{term.name}</span><small className="muted">Drop a class here</small>
                          </div>
                          {placedTermClasses.map((course) => <div className="placement-target-imported-class" key={`${course.sourceId}-${course.classKey}`} draggable onDragStart={(event) => startPlacementDrag(event, { type: "class", sourceId: course.sourceId, classKey: course.classKey, className: course.className, gradebookType: course.sourceType })}>
                            <span>{course.className}</span><small>Added from file</small>
                          </div>)}
                        </div>;
                      });
                      return <div className="placement-target-period-group" key={period.key}>
                        <div className="placement-target-period placement-target-period-drop" onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "period", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type, periodId })}>
                          <span>{period.name}</span><small className="muted">Drop a class here</small>
                        </div>
                        {placedClasses.map((course) => <div className="placement-target-imported-class" key={`${course.sourceId}-${course.classKey}`} draggable onDragStart={(event) => startPlacementDrag(event, { type: "class", sourceId: course.sourceId, classKey: course.classKey, className: course.className, gradebookType: course.sourceType })}>
                          <span>{course.className}</span><small>Added from file</small>
                        </div>)}
                        {placedTermGroups}
                      </div>;
                    }
                    return <details className="placement-target-period" key={period.key} open>
                      <summary onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "period", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type, periodId })}>
                        <span>{period.name}</span>
                      </summary>
                      {(period.terms || []).map((term) => {
                        const placedClasses = placedClassesForTerm(gradebook.id, term.id);
                        return <div className="placement-target-term-group" key={term.id}>
                          <div className="placement-target-term" onDragOver={allowPlacementDrop} onDrop={(event) => placeDroppedItem(event, { type: "term", gradebookId: gradebook.id, gradebookName: gradebook.name, gradebookType: gradebook.gradebook_type, termId: term.id })}>
                            <span>{term.name}</span><small className="muted">Drop a class here</small>
                          </div>
                          {placedClasses.map((course) => <div className="placement-target-imported-class" key={`${course.sourceId}-${course.classKey}`} draggable onDragStart={(event) => startPlacementDrag(event, { type: "class", sourceId: course.sourceId, classKey: course.classKey, className: course.className, gradebookType: course.sourceType })}>
                            <span>{course.className}</span><small>Added from file</small>
                          </div>)}
                        </div>;
                      })}
                    </details>;
                  })}
                </details>)}
              </section>
            </div>
            <div className="import-plan-actions">
              <button className="btn primary" type="button" onClick={importSetups} disabled={importBusy}>{importBusy ? "Importing…" : "Import setup"}</button>
              <button className="btn" type="button" onClick={clearImportPreview} disabled={importBusy}>Cancel import</button>
            </div>
          </div> : <p className="muted transfer-empty-state">Choose a setup file to review and place its gradebooks, periods, terms, and classes.</p>}
        </div>
      </div>
    </section>
  );
}

function normalizeClassLabels(value) {
  return (Array.isArray(value) ? value : [])
    .map((label) => ({ id: String(label?.id || ""), name: String(label?.name || "").trim() }))
    .filter((label) => label.id && label.name);
}

function ClassLabelsSettings({ appearance, onAppearanceChange }) {
  const { push } = useToasts();
  const [draft, setDraft] = useState("");
  const labels = normalizeClassLabels(appearance.classLabels);

  function updateLabels(nextLabels) {
    const validIds = new Set(nextLabels.map((label) => label.id));
    onAppearanceChange((current) => ({
      ...current,
      classLabels: nextLabels,
      courseLabels: Object.fromEntries(
        Object.entries(current.courseLabels || {})
          .map(([courseId, labelIds]) => [courseId, (Array.isArray(labelIds) ? labelIds : []).filter((id) => validIds.has(String(id)))])
          .filter(([, labelIds]) => labelIds.length),
      ),
    }));
  }

  function addLabel(event) {
    event.preventDefault();
    const name = draft.trim();
    if (!name || labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) return;
    updateLabels([...labels, { id: `class-label-${Date.now()}`, name }]);
    setDraft("");
  }

  function deleteLabel(label) {
    const labelId = String(label.id);
    const assignedToClass = Object.values(appearance.courseLabels || {}).some(
      (labelIds) => Array.isArray(labelIds) && labelIds.map(String).includes(labelId),
    );
    const remove = () => onAppearanceChange((current) => {
      const nextLabels = normalizeClassLabels(current.classLabels).filter((item) => item.id !== labelId);
      const validIds = new Set(nextLabels.map((item) => item.id));
      return {
        ...current,
        classLabels: nextLabels,
        courseLabels: Object.fromEntries(
          Object.entries(current.courseLabels || {})
            .map(([courseId, labelIds]) => [courseId, (Array.isArray(labelIds) ? labelIds : []).filter((id) => validIds.has(String(id)))])
            .filter(([, labelIds]) => labelIds.length),
        ),
      };
    });

    if (!assignedToClass) {
      remove();
      return;
    }

    push({
      id: `delete-class-label-${labelId}`,
      type: "persistent",
      message: "There is a class with this label. Delete this label?",
      confirmLabel: "Delete",
      dismissLabel: "Cancel",
      onConfirm: remove,
    });
  }

  return (
    <div className="class-labels-settings">
      <h3>Class Labels</h3>
      <p className="muted">Create labels you can assign to classes and use for GPA dashboard grouping.</p>
      <div className="class-label-list">
        {labels.map((label) => (
          <div className="class-label-row" key={label.id}>
            <input
              className="input"
              value={label.name}
              aria-label={`${label.name} class label`}
              onChange={(event) => updateLabels(labels.map((item) => item.id === label.id ? { ...item, name: event.target.value } : item))}
              onBlur={() => updateLabels(labels.map((item) => item.id === label.id ? { ...item, name: item.name.trim() || "Label" } : item))}
            />
            <button
              className="btn small danger"
              type="button"
              aria-label={`Delete ${label.name} class label`}
              onClick={() => deleteLabel(label)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <form className="class-label-add" onSubmit={addLabel}>
        <input
          className="input"
          value={draft}
          placeholder="Add a class label"
          aria-label="New class label"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="btn small" type="submit">Add label</button>
      </form>
    </div>
  );
}

function FlaggingSettings({ appearance, onAppearanceChange }) {
  const [colorDrafts, setColorDrafts] = useState({});
  const [nameDrafts, setNameDrafts] = useState({});
  const nameEditOriginals = useRef({});
  const flags = normalizeFlags(appearance.flags);

  function updateFlags(nextFlags) {
    onAppearanceChange((current) => ({ ...current, flags: nextFlags }));
  }

  function updateFlag(id, patch) {
    updateFlags(flags.map((flag) => (flag.id === id ? { ...flag, ...patch } : flag)));
  }

  function moveFlag(id, offset) {
    const from = flags.findIndex((flag) => flag.id === id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= flags.length) return;
    const next = [...flags];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    updateFlags(next);
  }

  function addFlag(event) {
    event.preventDefault();
    updateFlags([
      ...flags,
      {
        id: newFlagId(),
        name: "New flag",
        color: FALLBACK_COLORS[flags.length % FALLBACK_COLORS.length],
      },
    ]);
  }

  return (
    <section className="panel flagging-settings-panel">
      <h2>Assignment Flagging &amp; Class Labels</h2>
      <form className="flag-settings-form" onSubmit={addFlag}>
        <table className="flag-settings-table">
          <thead>
            <tr>
              <th aria-label="Flag" />
              <th>Name</th>
              <th>Color</th>
              <th aria-label="Reorder" />
            </tr>
          </thead>
          <tbody>
            {flags.map((flag) => (
              <tr
                key={flag.id}
              >
                <td>
                  <FlagIcon color={flag.color} size={21} />
                </td>
                <td>
                  <input
                    className="input flag-name-input"
                    value={nameDrafts[flag.id] ?? flag.name}
                    aria-label={`${flag.name} flag name`}
                    onFocus={() => {
                      nameEditOriginals.current[flag.id] = flag.name;
                      setNameDrafts((current) => Object.prototype.hasOwnProperty.call(current, flag.id)
                        ? current
                        : { ...current, [flag.id]: flag.name });
                    }}
                    onChange={(event) => setNameDrafts((current) => ({ ...current, [flag.id]: event.target.value }))}
                    onBlur={(event) => {
                      const original = nameEditOriginals.current[flag.id] ?? flag.name;
                      const nextName = event.target.value.trim() || original.trim() || "Flag";
                      setNameDrafts((current) => {
                        const next = { ...current };
                        delete next[flag.id];
                        return next;
                      });
                      delete nameEditOriginals.current[flag.id];
                      if (nextName !== flag.name) updateFlag(flag.id, { name: nextName });
                    }}
                  />
                </td>
                <td className="flag-color-cell">
                  <div className="flag-color-value">
                    <label className="flag-color-control">
                      <input
                        type="color"
                        value={flag.color}
                        aria-label={`${flag.name} flag color`}
                        onChange={(event) => updateFlag(flag.id, { color: event.target.value })}
                      />
                      <span style={{ background: flag.color }} />
                    </label>
                    <input
                      className="flag-color-code mono"
                      type="text"
                      inputMode="text"
                      maxLength={7}
                      value={colorDrafts[flag.id] ?? String(flag.color || "").toUpperCase()}
                      aria-label={`${flag.name} flag hex color`}
                      onChange={(event) => {
                        const value = event.target.value.toUpperCase();
                        setColorDrafts((current) => ({ ...current, [flag.id]: value }));
                        if (/^#[0-9A-F]{6}$/.test(value)) updateFlag(flag.id, { color: value.toLowerCase() });
                      }}
                      onBlur={() => {
                        setColorDrafts((current) => {
                          const next = { ...current };
                          delete next[flag.id];
                          return next;
                        });
                      }}
                    />
                  </div>
                  <div className="flag-settings-actions">
                    {flags.length > 1 ? <>
                    <button className="btn small" type="button" aria-label={`Move ${flag.name} flag up`} disabled={flags.indexOf(flag) === 0} onClick={() => moveFlag(flag.id, -1)}>↑</button>
                    <button className="btn small" type="button" aria-label={`Move ${flag.name} flag down`} disabled={flags.indexOf(flag) === flags.length - 1} onClick={() => moveFlag(flag.id, 1)}>↓</button>
                    <button
                      className="btn small danger"
                      type="button"
                      aria-label={`Delete ${flag.name} flag`}
                      onClick={() => updateFlags(flags.filter((item) => item.id !== flag.id))}
                    >
                      ×
                    </button>
                    </> : null}
                  </div>
                </td>
              </tr>
            ))}
            <tr className="flag-add-row">
              <td aria-hidden="true" />
              <td className="flag-add-name-cell">
                <div className="flag-add-inline">
                  <button className="btn small" type="submit">Add flag</button>
                </div>
              </td>
              <td aria-hidden="true" />
            </tr>
          </tbody>
        </table>
      </form>
      <div className="appearance-toggle flag-color-toggle">
        <span className="flag-color-toggle-label">
          <strong>Color Flagged Assignments</strong>
          <Tooltip text="Use the first flag’s color as a subtle background for flagged assignment rows." />
          <input
            type="checkbox"
            role="switch"
            aria-label="Color Flagged Assignments"
            checked={appearance.colorFlaggedAssignments === true}
            onChange={(event) => onAppearanceChange((current) => ({ ...current, colorFlaggedAssignments: event.target.checked }))}
          />
        </span>
        {appearance.colorFlaggedAssignments === true ? (
          <span className="flag-color-toggle-label">
            <strong>Readable Text Background</strong>
            <Tooltip text="Add background behind text and icons in the row to increase contrast and readability" />
            <input
              type="checkbox"
              role="switch"
              aria-label="Readable Text Background"
              checked={appearance.readableTextBackground !== false}
              onChange={(event) => onAppearanceChange((current) => ({ ...current, readableTextBackground: event.target.checked }))}
            />
          </span>
        ) : null}
      </div>
      <ClassLabelsSettings appearance={appearance} onAppearanceChange={onAppearanceChange} />
    </section>
  );
}

export default function Settings({ mode = "global", appearance, gradebookName = "", gradebookId = null, gradebooks = [], gradebookAppearances = {}, onGradebookNameChange, onGradebookOrderChange, onAddGradebook, onDeleteGradebook, onImportedGradebookSetups, academicPeriods = [], semesters = [], onAddAcademicPeriod, onDeleteAcademicPeriod, onAcademicPeriodChange, onAppearanceChange, onChange }) {
  const { push, warning } = useToasts();
  const creditTerms = useCreditTerms();
  const showScore = useShowScore();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateError, setUpdateError] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const [uninstallChecks, setUninstallChecks] = useState([false, false]);
  const [profileDrafts, setProfileDrafts] = useState({});
  const autoSaveReady = useRef(false);
  const [themePresetName, setThemePresetName] = useState("");
  const [gradeScalePresetName, setGradeScalePresetName] = useState("");
  const [themePresetCreateOpen, setThemePresetCreateOpen] = useState(false);
  const [gradeScaleCreateOpen, setGradeScaleCreateOpen] = useState(false);
  const [selectedScaleProfileId, setSelectedScaleProfileId] = useState(null);
  const [previewPresetId, setPreviewPresetId] = useState(null);
  const [defaultScalesOpen, setDefaultScalesOpen] = useState(true);
  const [customScalesOpen, setCustomScalesOpen] = useState(true);
  const [gradebookNameDraft, setGradebookNameDraft] = useState(gradebookName);
  const [newAcademicPeriodName, setNewAcademicPeriodName] = useState("");
  const [newSemesterTitleName, setNewSemesterTitleName] = useState("");
  const [academicPeriodBusy, setAcademicPeriodBusy] = useState(false);
  const [academicPeriodDrafts, setAcademicPeriodDrafts] = useState({});
  const savedThemePresets = appearance.themePresets || [];
  const savedGradeScalePresets = appearance.gradeScalePresets || [];
  const themePresetLimitReached = savedThemePresets.length >= MAX_CUSTOM_PRESETS;
  const gradeScalePresetLimitReached = savedGradeScalePresets.length >= MAX_CUSTOM_PRESETS;
  const orderedAcademicPeriods = (() => {
    const byKey = new Map(academicPeriods.map((period) => [String(period.key), period]));
    const configured = Array.isArray(appearance.highSchoolAcademicPeriodOrder) ? appearance.highSchoolAcademicPeriodOrder : [];
    const ordered = configured.map((key) => byKey.get(String(key))).filter(Boolean);
    academicPeriods.forEach((period) => {
      if (!ordered.some((item) => String(item.key) === String(period.key))) ordered.push(period);
    });
    return ordered;
  })();
  const highSchoolMultiTermPeriods = (() => {
    if (data?.gradebook_type !== "high_school") return [];
    const counts = new Map();
    semesters.forEach((semester) => {
      const key = highSchoolPeriodKey(semester);
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return orderedAcademicPeriods.filter((period) => (counts.get(String(period.key)) || 0) > 1);
  })();
  const overallRounding = data?.high_school_overall_rounding
    || data?.high_school_overall_rounding_by_period?.__default__
    || Object.values(data?.high_school_overall_rounding_by_period || {})[0]
    || {};

  useEffect(() => {
    setGradebookNameDraft(gradebookName);
  }, [gradebookName]);

  function saveGradebookName() {
    const nextName = gradebookNameDraft.trim();
    if (nextName && nextName !== gradebookName) onGradebookNameChange?.(nextName);
  }

  function moveGradebook(index, offset) {
    const nextIndex = index + offset;
    if (!onGradebookOrderChange || nextIndex < 0 || nextIndex >= gradebooks.length) return;
    const next = [...gradebooks];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    onGradebookOrderChange(next.map((item) => item.id));
  }

  async function addAcademicPeriod() {
    if (!newAcademicPeriodName.trim() || !onAddAcademicPeriod) return;
    setAcademicPeriodBusy(true);
    try { await onAddAcademicPeriod(newAcademicPeriodName); setNewAcademicPeriodName(""); }
    catch (err) { warning(err.message); }
    finally { setAcademicPeriodBusy(false); }
  }

  function addSemesterTitle(event) {
    event.preventDefault();
    const name = newSemesterTitleName.trim();
    if (!name) return;
    if (RESERVED_TERM_NAMES.has(normalizedName(name))) {
      warning("Term names can not be Settings or Overall.");
      return;
    }
    const titles = Array.isArray(appearance.semesterTitles) ? appearance.semesterTitles : [];
    if (titles.some((item) => normalizedName(item.name) === normalizedName(name))) {
      warning("Term names must be unique.");
      return;
    }
    onAppearanceChange((current) => ({
      ...current,
      semesterTitles: [
        ...(Array.isArray(current.semesterTitles) ? current.semesterTitles : []),
        { id: `custom-term-${Date.now()}`, name },
      ],
    }));
    setNewSemesterTitleName("");
  }

  function deleteSemesterTitle(item) {
    onAppearanceChange((current) => ({
      ...current,
      semesterTitles: (Array.isArray(current.semesterTitles) ? current.semesterTitles : [])
        .filter((term) => term.id !== item.id),
    }));
  }

  function deleteAcademicPeriod(period) {
    push({
      id: `delete-academic-period-${period.key}`,
      type: "persistent",
      title: "Delete period?",
      message: `Delete ${period.label || "this academic period"} and all of its terms and classes? This can not be undone.`,
      confirmLabel: "Delete",
      onConfirm: async () => {
        setAcademicPeriodBusy(true);
        try {
          await onDeleteAcademicPeriod?.(period.key);
        } catch (err) {
          warning(err.message);
        } finally {
          setAcademicPeriodBusy(false);
        }
      },
    });
  }

  function applyGpa(next, sortWeights = false) {
    const visible = sortWeights
      ? { ...next, gpa_weight_tags: sortWeightTags(next.gpa_weight_tags) }
      : next;
    setData(visible);
    setProfileDrafts(
      Object.fromEntries(
        (visible.scale_profiles || []).map((profile) => [
          profile.id,
          {
            name: profile.name,
            preset_id: profile.preset_id || "",
            rows: profile.rows.map((row) => ({ ...row })),
            minimum_passing_letter: profile.minimum_passing_letter || "C-",
            pass_fail: { ...(profile.pass_fail || { rows: [{ label: "S", min_percent: 70 }, { label: "U", min_percent: 0 }] }) },
          },
        ])
      )
    );
  }

  async function migrateHighSchoolTermsToCollege() {
    const builtInTerms = new Set(["transfer", "winter", "spring", "summer", "fall"]);
    const customTerms = semesters
      .filter((semester) => !builtInTerms.has(String(semester.season || "").toLowerCase()))
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (!customTerms.length) return;

    const used = new Set(semesters
      .filter((semester) => builtInTerms.has(String(semester.season || "").toLowerCase()))
      .map((semester) => collegeTermKey(semester.year, String(semester.season).toLowerCase())));
    let year = Math.max(new Date().getFullYear(), ...semesters.map((semester) => Number(semester.year) || 0));
    let sequenceIndex = 0;
    for (const semester of customTerms) {
      let key = collegeTermKey(year, COLLEGE_TERM_SEQUENCE[sequenceIndex]);
      while (used.has(key)) {
        sequenceIndex += 1;
        if (sequenceIndex >= COLLEGE_TERM_SEQUENCE.length) {
          sequenceIndex = 0;
          year -= 1;
        }
        key = collegeTermKey(year, COLLEGE_TERM_SEQUENCE[sequenceIndex]);
      }
      const season = COLLEGE_TERM_SEQUENCE[sequenceIndex];
      await api.patchSemester(semester.id, { year, season });
      used.add(key);
      sequenceIndex += 1;
      if (sequenceIndex >= COLLEGE_TERM_SEQUENCE.length) {
        sequenceIndex = 0;
        year -= 1;
      }
    }
  }

  useEffect(() => {
    let cancelled = false;
    const gpaParams = mode === "gradebook" && gradebookId ? { gradebook_id: gradebookId } : {};
    setLoading(true);
    setData(null);
    setError("");
    autoSaveReady.current = false;
    api.gpa(gpaParams)
      .then((next) => {
        if (!cancelled) applyGpa(next, true);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    api.meta().then(setMeta).catch(() => {});
    api.updates().then(setUpdateInfo).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gradebookId, mode]);

  useEffect(() => {
    if (!data || !autoSaveReady.current) {
      if (data) autoSaveReady.current = true;
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        await Promise.all(
          Object.entries(profileDrafts).map(([id, draft]) =>
            api.patchScaleProfile(id, {
              name: draft.name,
              rows: draft.rows,
              preset_id: draft.preset_id || null,
              pass_fail: draft.pass_fail,
              minimum_passing_letter: draft.minimum_passing_letter,
            })
          )
        );
        setError("");
      } catch (err) {
        setError(err.message);
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [data, profileDrafts]);

  useEffect(() => {
    if (!gradeScaleCreateOpen && !themePresetCreateOpen && !uninstallOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, [gradeScaleCreateOpen, themePresetCreateOpen, uninstallOpen]);

  async function refreshAll() {
    const gpaParams = mode === "gradebook" && gradebookId ? { gradebook_id: gradebookId } : {};
    const [gpa, nextMeta] = await Promise.all([api.gpa(gpaParams), api.meta().catch(() => null)]);
    applyGpa(gpa, true);
    if (nextMeta) setMeta(nextMeta);
    await onChange?.();
  }

  async function runUpdate() {
    setUpdateBusy(true);
    setUpdateError("");
    setUpdateMessage("");
    let restarting = false;
    try {
      const info = await api.updates();
      setUpdateInfo(info);
      if (!info.update_available) {
        setUpdateMessage(
          info.notes === "No GitHub release has been published yet."
            ? "No desktop release has been published yet."
            : "You're on the latest version."
        );
        return;
      }
      const result = await api.applyUpdate();
      if (result.restarting) {
        restarting = true;
        setUpdateMessage("Launching the installer and restarting…");
        return;
      }
      const fallback = result.download_url || result.release_url || info.download_url || meta?.release_url;
      if (fallback) {
        window.open(fallback, "_blank", "noopener,noreferrer");
        setUpdateMessage(`Version ${info.latest_version} is available. Opened the download in your browser.`);
      }
    } catch (err) {
      setUpdateError(err.message);
    } finally {
      if (!restarting) setUpdateBusy(false);
      try {
        await refreshAll();
        const nextInfo = await api.updates().catch(() => null);
        if (nextInfo) setUpdateInfo(nextInfo);
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function updateSettings(patch) {
    try {
      applyGpa(await api.patchSettings(patch, mode === "gradebook" ? gradebookId : null));
      await onChange?.();
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateOverallRounding(field, checked) {
    const next = {
      ...overallRounding,
      [field]: checked,
    };
    await updateSettings({ high_school_overall_rounding: next });
    onAppearanceChange?.((current) => ({
      ...current,
      highSchoolOverallRoundingByPeriod: { __default__: next },
    }));
  }

  function saveWeightTags(nextTags) {
    const sortedTags = sortWeightTags(nextTags);
    applyGpa({ ...data, gpa_weight_tags: sortedTags });
    updateSettings({ gpa_weight_tags: sortedTags });
  }

  async function refreshProfiles() {
    try {
      await refreshAll();
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }

  function updateProfileDraft(id, patch) {
    setProfileDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  }

  async function saveProfile(id) {
    const draft = profileDrafts[id];
    if (!draft) return;
    try {
      await api.patchScaleProfile(id, {
        name: draft.name,
        rows: draft.rows,
        preset_id: draft.preset_id || null,
        pass_fail: draft.pass_fail,
        minimum_passing_letter: draft.minimum_passing_letter,
      });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function applyPresetToProfile(id, preset) {
    try {
      await api.patchScaleProfile(id, { rows: preset.rows, pass_fail: preset.pass_fail, minimum_passing_letter: preset.minimum_passing_letter, preset_id: preset.id });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function makeAnotherDefault(viewedPreset = null) {
    try {
      const sourceProfile = profiles.find((profile) => profile.id === selectedScaleProfileId) || profiles.find((profile) => profile.is_primary) || profiles[0];
      const source = viewedPreset || (sourceProfile ? (profileDrafts[sourceProfile.id] || sourceProfile) : null);
      const created = await api.createScaleProfile(source ? {
        name: `${source.name || "Custom scale"} copy`,
        rows: source.rows,
        pass_fail: source.pass_fail,
        minimum_passing_letter: source.minimum_passing_letter,
        preset_id: null,
      } : {});
      setPreviewPresetId(null);
      setSelectedScaleProfileId(created.id);
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function makePrimary(id) {
    try {
      await api.patchScaleProfile(id, { is_primary: true });
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  async function favoritePreset(preset) {
    try {
      const existing = profiles.find((profile) => profile.preset_id === preset.id);
      if (existing) {
        await makePrimary(existing.id);
        setSelectedScaleProfileId(existing.id);
      } else {
        const created = await api.createScaleProfile({
          name: preset.name,
          rows: preset.rows,
          pass_fail: preset.pass_fail,
          minimum_passing_letter: preset.minimum_passing_letter,
          preset_id: preset.id,
          is_primary: true,
        });
        setSelectedScaleProfileId(created.id);
        await refreshProfiles();
      }
      push({ type: "timed", message: `${preset.name} is now the default grade scale`, durationMs: 3200 });
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeProfile(id) {
    try {
      await api.deleteScaleProfile(id);
      await refreshProfiles();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!data) {
    return (
      <>
        <div className="topbar">
          <div>
            <h1>{mode === "gradebook" ? "Gradebook Settings" : "Application Settings"}</h1>
          </div>
        </div>
        <section className="panel">
          <h2>{loading ? "Loading settings…" : "Settings unavailable"}</h2>
          {!loading ? <p className="error">{error || "The settings could not be loaded."}</p> : null}
          {!loading ? (
            <button className="btn primary" type="button" onClick={() => window.location.reload()}>
              Retry
            </button>
          ) : null}
        </section>
      </>
    );
  }

  const presetNames = {
    ncsu: "North Carolina State University",
    unc: "UNC Chapel Hill",
    clemson: "Clemson University",
    ecu: "East Carolina University",
    uncw: "UNC Wilmington",
    uncc: "UNC Charlotte",
    duke: "Duke University",
    cofc: "College of Charleston",
  };
  const presets = (data.scale_presets || meta?.scale_presets || []).map((preset) => ({
    ...preset,
    name: presetNames[preset.id] || preset.name,
  }));
  const profiles = data.scale_profiles || [];
  const targetLetters = (data.default_scale || [])
    .filter((row) => row.letter !== "F")
    .map((row) => row.letter);
  const targets = targetLetters.length ? [...targetLetters] : [...TARGETS];
  const targetGradePoints = new Map((data.default_scale || []).map((row) => [row.letter, row.quality_points]));
  if (data.target_letter && !targets.includes(data.target_letter)) {
    targets.unshift(data.target_letter);
  }
  const weightTags = data.gpa_weight_tags?.length
    ? data.gpa_weight_tags
    : [{ id: "unweighted", name: "Unweighted", boost: 0 }, { id: "weighted", name: "Weighted", boost: 0.5 }];

  return (
    <div className={`settings-page settings-page-${mode}`}>
      <div className="topbar">
        <div>
          <h1>{mode === "gradebook" ? "Gradebook Settings" : "Application Settings"}</h1>
        </div>
        <div className="topbar-actions">
          {mode === "gradebook" && onDeleteGradebook ? <button className="btn danger" type="button" onClick={() => onDeleteGradebook()}>Delete Gradebook</button> : null}
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <section className="panel update-panel">
        <h2>Updates</h2>
        <p className="muted settings-note" style={{ marginTop: 0 }}>
          Current version <span className="mono">{meta?.version || "…"}</span>
          {meta?.frozen
            ? " — installs over this app and restarts."
            : " — this development build can not replace itself; Update opens the GitHub release."}
        </p>
        <div className="update-actions">
          <button className="btn primary" type="button" disabled={updateBusy} onClick={runUpdate}>
            {updateBusy ? "Updating…" : "Update"}
          </button>
          {meta?.release_url ? (
            <a className="btn" href={meta.release_url} target="_blank" rel="noreferrer">
              View releases
            </a>
          ) : null}
        </div>
        {mode === "global" ? (
          <label className="update-notification-setting">
            <span><strong>Disable update notifications</strong><small>Updates can still be checked manually from this page.</small></span>
            <input type="checkbox" role="switch" checked={updateInfo?.notifications_disabled === true} onChange={async (event) => { try { const preference = await api.setUpdateNotifications(event.target.checked); setUpdateInfo((current) => ({ ...current, ...preference })); } catch (err) { warning(err.message); } }} />
          </label>
        ) : null}
        <div className="update-uninstall-action"><button className="btn danger" type="button" onClick={() => { setUninstallChecks([false, false]); setUninstallOpen(true); }}>Uninstall Grade Calculator</button></div>
        {updateMessage ? <p className="pos">{updateMessage}</p> : null}
        {updateError ? <p className="error">{updateError}</p> : null}
        {updateInfo?.apply_status?.status === "failed_launched_staged" ||
        updateInfo?.apply_status?.status === "failed" ? (
          <p className="error">
            {updateInfo.apply_status.message ||
              "The last update could not replace the installed file. Check Settings after relaunching from the download folder."}
          </p>
        ) : null}
        {updateInfo?.update_available && updateInfo.notes ? (
          <pre className="update-notes">{updateInfo.notes}</pre>
        ) : null}
      </section>

      {uninstallOpen ? createPortal((
        <div className="uninstall-modal" role="dialog" aria-modal="true" aria-label="Uninstall Grade Calculator" onWheel={(e) => e.preventDefault()} onTouchMove={(e) => e.preventDefault()}>
          <div className="uninstall-modal-card">
            <h1>Uninstall Grade Calculator?</h1>
            <p>This permanently removes the app and all Grade Calculator data from this computer.</p>
            <label className="checkbox"><input type="checkbox" checked={uninstallChecks[0]} onChange={(e) => setUninstallChecks(([_, second]) => [e.target.checked, second])} />Are you sure you want to uninstall?</label>
            <label className="checkbox"><input type="checkbox" checked={uninstallChecks[1]} onChange={(e) => setUninstallChecks(([first]) => [first, e.target.checked])} />Are you totally sure?</label>
            <div className="update-actions"><button className="btn" type="button" onClick={() => setUninstallOpen(false)}>Cancel</button><button className="btn danger" type="button" disabled={!uninstallChecks.every(Boolean)} onClick={async () => { try { const result = await api.uninstall(); if (!result.ok) warning("Uninstall is available only from the packaged Windows or macOS app."); } catch (err) { warning(err.message); } }}>Final uninstall</button></div>
          </div>
        </div>
      ), document.body) : null}

      {mode === "global" ? <section className="panel appearance-panel">
        <h2>Appearance</h2>
        {gradebooks.length ? (
          <section className="gradebook-order-settings">
            <p className="muted settings-note gradebook-order-heading">Gradebook order</p>
            <table className="semester-titles-table gradebook-order-table">
              <thead><tr><th>Name</th><th>Order</th><th aria-label="Delete" /></tr></thead>
              <tbody>
                {gradebooks.map((gradebook, index) => (
                  <tr key={gradebook.id}>
                    <td>{gradebook.name}</td>
                    <td className="period-order-actions">
                      {index > 0 ? <button className="btn small period-order-up" type="button" aria-label={`Move ${gradebook.name} up`} onClick={() => moveGradebook(index, -1)}>↑</button> : <span className="period-order-spacer period-order-up-spacer" aria-hidden="true" />}
                      {index < gradebooks.length - 1 ? <button className="btn small period-order-down" type="button" aria-label={`Move ${gradebook.name} down`} onClick={() => moveGradebook(index, 1)}>↓</button> : <span className="period-order-spacer period-order-down-spacer" aria-hidden="true" />}
                    </td><td><button className="btn small danger" type="button" aria-label={`Delete ${gradebook.name}`} onClick={() => onDeleteGradebook?.(gradebook.id)}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {onAddGradebook ? <div className="settings-add-period gradebook-order-add"><button className="btn small" type="button" onClick={onAddGradebook}>Add gradebook</button></div> : null}
          </section>
        ) : null}
        <div className="appearance-settings">
          <label className="appearance-toggle">
            <span>
              <strong>Color Assignment Grades</strong>
              <small>Color individual assignment scores in each class using the A+ through F color key.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={appearance.gradeColors}
              onChange={(e) =>
                onAppearanceChange((current) => ({ ...current, gradeColors: e.target.checked }))
              }
            />
          </label>
          <label className="appearance-toggle">
            <span>
              <strong>Show Tooltips</strong>
              <small>Show information icons and their hover descriptions throughout the app.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={appearance.tooltips !== false}
              onChange={(e) =>
                onAppearanceChange((current) => ({ ...current, tooltips: e.target.checked }))
              }
            />
          </label>
        </div>
        <div className="grade-scale-picker">
          <p className="muted settings-note" style={{ marginTop: 14, marginBottom: 10 }}>
            Grade color scale
          </p>
          <div className="grade-scale-options">
            {GRADE_SCALES.map((scale) => {
              const selected = appearance.gradeScale === scale.id;
              return (
                <button
                  key={scale.id}
                  type="button"
                  className={`grade-scale-option ${selected ? "active" : ""}`}
                  onClick={() => onAppearanceChange((current) => ({ ...current, gradeScale: scale.id }))}
                >
                  <span className="grade-scale-option-head">
                    <strong>{scale.name}</strong>
                    {scale.id === "classic" ? <span className="muted">Default</span> : null}
                  </span>
                  <small className="muted">{scale.description}</small>
                  <span className="grade-scale-swatches">
                    {PREVIEW_LETTERS.map(([letter, key]) => (
                      <span
                        key={letter}
                        className="grade-scale-swatch"
                        style={{ background: scale.colors[key] }}
                        title={letter}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
            {savedGradeScalePresets.map((preset) => {
              const selected = appearance.gradeScale === preset.id;
              return (
                <div key={preset.id} className={`grade-scale-option saved-theme-option ${selected ? "active" : ""}`}>
                  <button
                    type="button"
                    className="saved-theme-select"
                    onClick={() =>
                      onAppearanceChange((current) => ({
                        ...current,
                        gradeScale: preset.id,
                      }))
                    }
                  >
                    <span className="grade-scale-option-head">
                      <strong>{preset.name}</strong>
                      <span className="muted">Saved</span>
                    </span>
                    <span className="grade-scale-swatches">
                      {PREVIEW_LETTERS.map(([letter, key]) => (
                        <span
                          key={letter}
                          className="grade-scale-swatch"
                          style={{ background: preset.colors[key] }}
                          title={letter}
                        />
                      ))}
                    </span>
                  </button>
                  <button
                    className="btn small danger saved-theme-delete"
                    type="button"
                    onClick={() =>
                      onAppearanceChange((current) => {
                        const gradeScalePresets = (current.gradeScalePresets || []).filter(
                          (item) => item.id !== preset.id
                        );
                        const selectedStill = current.gradeScale === preset.id;
                        return {
                          ...current,
                          gradeScalePresets,
                          gradeScale: selectedStill ? "classic" : current.gradeScale,
                        };
                      })
                    }
                  >
                    Delete
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="grade-scale-option add-custom-grade-scale"
              disabled={gradeScalePresetLimitReached}
              title={gradeScalePresetLimitReached ? `Maximum ${MAX_CUSTOM_PRESETS} saved palettes` : undefined}
              onClick={() => {
                if (!gradeScalePresetLimitReached) setGradeScaleCreateOpen(true);
              }}
            >
              <span className="add-custom-grade-scale-plus" aria-hidden="true">+</span>
              <strong>Add Custom</strong>
              <small className="muted">Create an editable palette from the current colors</small>
            </button>
          </div>
          <div className={`custom-grade-scale ${appearance.gradeScale === "custom" || savedGradeScalePresets.some((preset) => preset.id === appearance.gradeScale) ? "active" : ""}`}>
            <div className="custom-grade-scale-head">
              <span>
                <strong>{appearance.gradeScale === "custom" || savedGradeScalePresets.some((preset) => preset.id === appearance.gradeScale) ? "Custom palette" : "Palette"}</strong>
              </span>
            </div>
            <div className="custom-grade-colors">
              {CUSTOM_LETTERS.map(([letter, key]) => {
                const custom = appearance.gradeScale === "custom" || savedGradeScalePresets.some((preset) => preset.id === appearance.gradeScale);
                const colors = getActiveGradeColors(appearance);
                return (
                  <label className={`custom-grade-color ${custom ? "" : "locked"}`} key={key}>
                    <input
                      type="color"
                      value={colors[key]}
                      disabled={!custom}
                      onChange={(e) =>
                        onAppearanceChange((current) => {
                          const nextColors = { ...getActiveGradeColors(current), [key]: e.target.value };
                          const selectedPreset = (current.gradeScalePresets || []).some((item) => item.id === current.gradeScale);
                          return selectedPreset
                            ? {
                                ...current,
                                gradeScalePresets: current.gradeScalePresets.map((item) =>
                                  item.id === current.gradeScale ? { ...item, colors: nextColors } : item
                                ),
                              }
                            : { ...current, customGradeColors: nextColors };
                        })
                      }
                      aria-label={`${letter} color`}
                    />
                    <span>{letter}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
        {gradeScaleCreateOpen ? createPortal((
          <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.preventDefault()} onTouchMove={(e) => e.preventDefault()}>
            <form
              className="modal panel grade-scale-create-modal"
              role="dialog"
              aria-modal="true"
              onSubmit={(e) => {
                e.preventDefault();
                if (gradeScalePresetLimitReached) return;
                const name = gradeScalePresetName.trim() || "My palette";
                const id = `grade-${Date.now()}`;
                onAppearanceChange((current) => ({
                  ...current,
                  gradeScale: id,
                  gradeScalePresets: [
                    ...(current.gradeScalePresets || []),
                    { id, name, colors: getActiveGradeColors(current) },
                  ],
                }));
                setGradeScalePresetName("");
                setGradeScaleCreateOpen(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <h2>New custom palette</h2>
              <label className="muted">
                Palette name
                <input
                  className="input"
                  autoFocus
                  value={gradeScalePresetName}
                  placeholder="My course colors"
                  onChange={(e) => setGradeScalePresetName(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setGradeScaleCreateOpen(false)}>Cancel</button>
                <button className="btn primary" type="submit">Create palette</button>
              </div>
            </form>
          </div>
        ), document.body) : null}
        <p className="muted settings-note app-colors-heading" style={{ marginTop: 18, marginBottom: 10 }}>
          App Colors
        </p>
        <div className="grade-scale-options">
          {THEME_PRESETS.map((preset) => {
            const selected = appearance.themeScale === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={`grade-scale-option ${selected ? "active" : ""}`}
                onClick={() =>
                  onAppearanceChange((current) => ({
                    ...current,
                    ...appearanceFromThemePreset(preset),
                  }))
                }
              >
                <span className="grade-scale-option-head">
                  <strong>{preset.name}</strong>
                  {preset.id === "classic" ? <span className="muted">Default</span> : null}
                </span>
                <small className="muted">{preset.description}</small>
                <span className="grade-scale-swatches">
                  {["primary", "secondary", "tertiary"].map((key) => (
                    <span
                      key={key}
                      className="grade-scale-swatch"
                      style={{ background: preset[key] }}
                      title={key}
                    />
                  ))}
                </span>
              </button>
            );
          })}
          {(appearance.themePresets || []).map((preset) => {
            const selected = appearance.themeScale === preset.id;
            return (
              <div key={preset.id} className={`grade-scale-option saved-theme-option ${selected ? "active" : ""}`}>
                <button
                  type="button"
                  className="saved-theme-select"
                  onClick={() =>
                    onAppearanceChange((current) => ({
                      ...current,
                      ...appearanceFromThemePreset(preset),
                    }))
                  }
                >
                  <span className="grade-scale-option-head">
                    <strong>{preset.name}</strong>
                    <span className="muted">Saved</span>
                  </span>
                  <span className="grade-scale-swatches">
                    {["primary", "secondary", "tertiary"].map((key) => (
                      <span
                        key={key}
                        className="grade-scale-swatch"
                        style={{ background: preset[key] }}
                        title={key}
                      />
                    ))}
                  </span>
                </button>
                <button
                  className="btn small danger saved-theme-delete"
                  type="button"
                  onClick={() =>
                    onAppearanceChange((current) => {
                      const themePresets = (current.themePresets || []).filter((item) => item.id !== preset.id);
                      const selectedStill = current.themeScale === preset.id;
                      return {
                        ...current,
                        themePresets,
                        ...(selectedStill ? appearanceFromThemePreset(THEME_PRESETS[0]) : {}),
                        themeScale: selectedStill ? THEME_PRESETS[0].id : current.themeScale,
                      };
                    })
                  }
                >
                  Delete
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="grade-scale-option add-custom-grade-scale"
            disabled={themePresetLimitReached}
            title={themePresetLimitReached ? `Maximum ${MAX_CUSTOM_PRESETS} saved palettes` : undefined}
            onClick={() => {
              if (!themePresetLimitReached) setThemePresetCreateOpen(true);
            }}
          >
            <span className="add-custom-grade-scale-plus" aria-hidden="true">+</span>
            <strong>Add Custom</strong>
            <small className="muted">Create an editable palette from the current colors</small>
          </button>
        </div>
        <div className={`theme-colors ${appearance.themeScale === "custom" || (appearance.themePresets || []).some((preset) => preset.id === appearance.themeScale) ? "active" : ""}`}>
          {COLOR_FIELDS.map(([key, label]) => (
            <label className="theme-color" key={key}>
              <span>
                <strong>{label}</strong>
              </span>
              <span className="theme-color-controls">
                <input
                  type="color"
                  value={appearance[key]}
                  disabled={appearance.themeScale !== "custom" && !(appearance.themePresets || []).some((preset) => preset.id === appearance.themeScale)}
                  onChange={(e) =>
                    onAppearanceChange((current) => {
                      const nextValue = e.target.value;
                      const selectedPreset = (current.themePresets || []).some((item) => item.id === current.themeScale);
                      return selectedPreset
                        ? {
                            ...current,
                            [key]: nextValue,
                            themePresets: current.themePresets.map((item) =>
                              item.id === current.themeScale ? { ...item, [key]: nextValue } : item
                            ),
                          }
                        : { ...current, themeScale: "custom", [key]: nextValue };
                    })
                  }
                  aria-label={label}
                />
                <input
                  className="input mono"
                  value={appearance[key]}
                  disabled={appearance.themeScale !== "custom" && !(appearance.themePresets || []).some((preset) => preset.id === appearance.themeScale)}
                  onChange={(e) =>
                    onAppearanceChange((current) => {
                      const nextValue = e.target.value;
                      const selectedPreset = (current.themePresets || []).some((item) => item.id === current.themeScale);
                      return selectedPreset
                        ? {
                            ...current,
                            [key]: nextValue,
                            themePresets: current.themePresets.map((item) =>
                              item.id === current.themeScale ? { ...item, [key]: nextValue } : item
                            ),
                          }
                        : { ...current, themeScale: "custom", [key]: nextValue };
                    })
                  }
                  spellCheck={false}
                />
              </span>
            </label>
          ))}
        </div>
        <label className="appearance-toggle appearance-subtoggle">
          <span>
            <strong>Auto-contrast text</strong>
            <small>
              When the background is light, switch body text to dark. Turn off to pick a fixed text color
              instead.
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={appearance.autoContrastText !== false}
            onChange={(e) =>
              onAppearanceChange((current) => ({
                ...current,
                autoContrastText: e.target.checked,
                textColor: current.textColor || DEFAULT_COLORS.text,
              }))
            }
          />
        </label>
        {appearance.autoContrastText === false ? (
          <label className="theme-color appearance-subtoggle">
            <span>
              <strong>Text</strong>
              <small>Body text color when auto-contrast is off.</small>
            </span>
            <span className="theme-color-controls">
              <input
                type="color"
                value={appearance.textColor || DEFAULT_COLORS.text}
                onChange={(e) =>
                  onAppearanceChange((current) => ({
                    ...current,
                    textColor: e.target.value,
                  }))
                }
                aria-label="Text color"
              />
              <input
                className="input mono"
                value={appearance.textColor || DEFAULT_COLORS.text}
                onChange={(e) =>
                  onAppearanceChange((current) => ({
                    ...current,
                    textColor: e.target.value,
                  }))
                }
                spellCheck={false}
              />
            </span>
          </label>
        ) : null}
        {themePresetCreateOpen ? createPortal((
          <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.stopPropagation()} onWheel={(e) => e.preventDefault()} onTouchMove={(e) => e.preventDefault()}>
            <form
              className="modal panel grade-scale-create-modal"
              role="dialog"
              aria-modal="true"
              onSubmit={(e) => {
                e.preventDefault();
                if (themePresetLimitReached) return;
                const name = themePresetName.trim() || "My palette";
                const id = `theme-${Date.now()}`;
                onAppearanceChange((current) => ({
                  ...current,
                  themeScale: id,
                  themePresets: [
                    ...(current.themePresets || []),
                    themePresetFromAppearance(current, id, name),
                  ],
                }));
                setThemePresetName("");
                setThemePresetCreateOpen(false);
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <h2>New custom appearance</h2>
              <label className="muted">
                Appearance name
                <input
                  className="input"
                  autoFocus
                  value={themePresetName}
                  placeholder="My course colors"
                  onChange={(e) => setThemePresetName(e.target.value)}
                />
              </label>
              <div className="modal-actions">
                <button className="btn" type="button" onClick={() => setThemePresetCreateOpen(false)}>Cancel</button>
                <button className="btn primary" type="submit">Create custom</button>
              </div>
            </form>
          </div>
        ), document.body) : null}
      </section> : null}

      <FlaggingSettings appearance={appearance} onAppearanceChange={onAppearanceChange} />

      <section className="panel scale-profiles-panel" style={{ marginTop: 16 }}>
        <div className="tooltip-heading">
          <h2>Grade scales</h2>
          <Tooltip side="right" text="New classes copy the ★ starred scale. Existing classes keep their own cutoffs unless you apply a default in the gradebook. GPA decimals matter: 3, 3.3, 3.33, and 3.333 are not the same." />
        </div>
        {(() => {
          const primaryProfile = profiles.find((profile) => profile.is_primary) || profiles[0];
          const selectedProfile = profiles.find((profile) => profile.id === selectedScaleProfileId) || primaryProfile;
          const customProfiles = profiles.filter((profile) => !profile.preset_id);
          return (
            <div className="scale-profiles-layout">
              <aside className="scale-profile-list">
                <div className="scale-list-section">
                  <button className="scale-list-heading" type="button" onClick={() => setDefaultScalesOpen((open) => !open)}>
                    <span>{defaultScalesOpen ? "▾" : "▸"} Default Scales</span>
                  </button>
                  {defaultScalesOpen ? presets.map((preset) => {
                    const selected = previewPresetId === preset.id;
                    const favorited = primaryProfile?.preset_id === preset.id;
                    return (
                      <div className={`scale-list-item ${selected ? "selected" : ""} ${favorited ? "favorited" : ""}`} key={preset.id}>
                        <button className={`scale-list-star ${favorited ? "active" : ""}`} type="button" aria-label={`Make ${preset.name} the default scale`} onClick={() => {
                          if (!primaryProfile) return;
                          setPreviewPresetId(null);
                          favoritePreset(preset);
                        }}>{favorited ? "★" : "☆"}</button>
                        <button className="scale-list-name" type="button" onClick={() => {
                          if (primaryProfile) {
                            setSelectedScaleProfileId(primaryProfile.id);
                            setPreviewPresetId(preset.id);
                          }
                        }}>{preset.name}</button>
                      </div>
                    );
                  }) : null}
                </div>
                <div className="scale-list-section">
                  <button className="scale-list-heading" type="button" onClick={() => setCustomScalesOpen((open) => !open)}>
                    <span>{customScalesOpen ? "▾" : "▸"} Custom Scales</span>
                  </button>
                  {customScalesOpen ? (
                    <>
                      {customProfiles.map((profile) => (
                        <div className={`scale-list-item ${selectedProfile?.id === profile.id ? "selected" : ""} ${profile.is_primary ? "favorited" : ""}`} key={profile.id}>
                          <button className={`scale-list-star ${profile.is_primary ? "active" : ""}`} type="button" aria-label={`Make ${profile.name} the default scale`} onClick={() => { setPreviewPresetId(null); makePrimary(profile.id); push({ type: "timed", message: `${profile.name} is now the default grade scale`, durationMs: 3200 }); }}>{profile.is_primary ? "★" : "☆"}</button>
                          <button className="scale-list-name" type="button" onClick={() => { setPreviewPresetId(null); setSelectedScaleProfileId(profile.id); }}>{profile.name}</button>
                        </div>
                      ))}
                      <button className="scale-list-create btn small" type="button" onClick={() => makeAnotherDefault(previewPresetId ? presets.find((preset) => preset.id === previewPresetId) : null)}>Create New Scale</button>
                    </>
                  ) : null}
                </div>
              </aside>
              {selectedProfile ? (() => {
                const profile = selectedProfile;
                const profileDraft = profileDrafts[profile.id] || {
            name: profile.name,
            preset_id: profile.preset_id || "",
            rows: profile.rows.map((row) => ({ ...row })),
            minimum_passing_letter: profile.minimum_passing_letter || "C-",
            pass_fail: { ...(profile.pass_fail || { rows: [{ label: "S", min_percent: 70 }, { label: "U", min_percent: 0 }] }) },
          };
                const previewPreset = presets.find((preset) => preset.id === previewPresetId);
                const draft = previewPreset && profile.id === primaryProfile?.id
                  ? { ...profileDraft, rows: previewPreset.rows.map((row) => ({ ...row })), pass_fail: previewPreset.pass_fail, minimum_passing_letter: previewPreset.minimum_passing_letter, preset_id: previewPreset.id }
                  : profileDraft;
                const displayName = previewPreset?.name || (profile.preset_id ? presets.find((preset) => preset.id === profile.preset_id)?.name : draft.name) || draft.name;
                return <div className="scale-profile-card" key={profile.id}>
              <div className="scale-profile-head">
                <label className="muted">
                  Name
                  <input
                    className="input"
                    disabled={Boolean(profile.preset_id || previewPreset)}
                    style={{ display: "block", marginTop: 6, width: "min(100%, 360px)", minWidth: 0, boxSizing: "border-box" }}
                    value={displayName}
                    onChange={(event) => updateProfileDraft(profile.id, { name: event.target.value })}
                    onBlur={() => {
                      const name = draft.name.trim();
                      if (name && name !== profile.name) {
                        api.patchScaleProfile(profile.id, { name }).then(() => refreshProfiles()).catch((err) => setError(err.message));
                      }
                    }}
                  />
                </label>
                <div className="scale-profile-actions">
                  {profile.preset_id ? (
                    <button className="btn small" type="button" onClick={() => {
                      const preset = presets.find((item) => item.id === profile.preset_id);
                      if (preset) applyPresetToProfile(profile.id, preset);
                    }}>Reset to Default</button>
                  ) : null}
                  {!profile.preset_id && profiles.length > 1 ? (
                    <button className="btn small danger" type="button" onClick={() => removeProfile(profile.id)}>
                      Delete
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="default-scale-editor">
                <div className="grade-scale-table">
                  <ScaleRowsEditor
                    rows={draft.rows}
                    allowRemove={!draft.preset_id}
                    minimumPassingLetter={draft.minimum_passing_letter}
                    onMinimumPassingLetterChange={(letter) => {
                      const preset = presets.find((item) => item.id === draft.preset_id);
                      const samePreset = preset
                        && scalesMatch(draft.rows, preset.rows)
                        && JSON.stringify(preset.pass_fail?.rows || []) === JSON.stringify(draft.pass_fail?.rows || [])
                        && preset.minimum_passing_letter === letter;
                      updateProfileDraft(profile.id, {
                        minimum_passing_letter: letter,
                        preset_id: samePreset ? draft.preset_id : "",
                      });
                    }}
                    onChange={(rows) => {
                      const preset = presets.find((item) => item.id === draft.preset_id);
                      const stillMatches = preset
                        ? scalesMatch(rows, preset.rows)
                          && JSON.stringify(preset.pass_fail?.rows || []) === JSON.stringify(draft.pass_fail?.rows || [])
                          && preset.minimum_passing_letter === draft.minimum_passing_letter
                        : false;
                      updateProfileDraft(profile.id, {
                        rows,
                        minimum_passing_letter: rows.some((row) => row.letter === draft.minimum_passing_letter)
                          ? draft.minimum_passing_letter
                          : (rows[0]?.letter || ""),
                        preset_id: stillMatches ? draft.preset_id : "",
                      });
                    }}
                  />
                  <PassFailScaleEditor
                    passFail={draft.pass_fail}
                    allowRemove={!draft.preset_id}
                    scale={draft.rows}
                    onChange={(pass_fail) => {
                      const preset = presets.find((item) => item.id === draft.preset_id);
                      const samePassFail = preset?.pass_fail
                        && JSON.stringify(preset.pass_fail.rows || []) === JSON.stringify(pass_fail.rows || [])
                        && preset.minimum_passing_letter === draft.minimum_passing_letter;
                      updateProfileDraft(profile.id, {
                        pass_fail,
                        preset_id: samePassFail ? draft.preset_id : "",
                      });
                    }}
                  />
                </div>
              </div>
                </div>;
              })() : <p className="muted">Select a scale to edit it.</p>}
            </div>
          );
        })()}
      </section>

      <section className="panel gpa-calculation-panel" style={{ marginTop: 16 }}>
        <div className="settings-gradebook-setup">
          <h3>Gradebook Setup</h3>
          <div className="settings-gradebook-setup-fields">
            {mode === "gradebook" && onGradebookNameChange ? (
              <label className="gradebook-name-inline">
                <span>Gradebook Name:</span>
                <input
                  className="input"
                  value={gradebookNameDraft}
                  aria-label="Gradebook name"
                  onChange={(event) => setGradebookNameDraft(event.target.value)}
                  onBlur={saveGradebookName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveGradebookName();
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
            ) : null}
            <label className="muted">
              <span className="settings-field-label">Gradebook type <Tooltip anchor="icon" text="Single-term classes are completed in one term (typical for colleges). Multi-term classes can span terms and combine their term grades (typical for high schools)." /></span>
              <select
                className="select"
                value={data.gradebook_type || "college"}
                onChange={async (e) => {
                  const nextType = e.target.value;
                  const highSchool = nextType === "high_school";
                  if (!highSchool && (data.gradebook_type || "college") === "high_school") {
                    try {
                      await migrateHighSchoolTermsToCollege();
                    } catch (err) {
                      setError(`Could not convert custom terms: ${err.message}`);
                    }
                  }
                  await updateSettings({ gradebook_type: nextType, ...(highSchool ? { gpa_basis: "classes" } : {}) });
                  if (highSchool) onAppearanceChange((current) => ({ ...current, creditLabelId: "classes" }));
                }}
              >
                <option value="college">Single-term</option>
                <option value="high_school">Multi-term</option>
              </select>
            </label>
            <label className="muted">
              <span className="settings-field-label">Unit Type <Tooltip anchor="icon" text="Fixed Units count each class as one unit, though Multi-term gradebooks can make class have partial units. Variable Unit weights classes by their assigned credits or units. Multi-term gradebooks are locked to Fixed Units." /></span>
              <select className="select" disabled={(data.gradebook_type || "college") === "high_school"} value={(data.gradebook_type || "college") === "high_school" ? "classes" : (data.gpa_basis || "credits")} onChange={(e) => {
                updateSettings({ gpa_basis: e.target.value });
                onAppearanceChange((current) => ({ ...current, creditLabelId: e.target.value === "classes" ? "classes" : "credits" }));
              }}>
                {(data.gradebook_type || "college") === "high_school" ? <option value="classes">Fixed Unit</option> : <>
                  <option value="credits">Variable Unit</option>
                  <option value="classes">Fixed Unit</option>
                </>}
              </select>
            </label>
          </div>
        </div>
          <div className="settings-fields settings-label-fields">
            <div className="settings-gpa-calculation-group">
              <h3>GPA Calculation Options</h3>
              <div className="settings-gpa-options settings-failing-gpa-option">
                <label className="checkbox settings-gpa-option">
                  <input
                    type="checkbox"
                    checked={Boolean(data.fail_pass_fail_affects_gpa)}
                    onChange={(e) => updateSettings({ fail_pass_fail_affects_gpa: e.target.checked })}
                  />
                  <span>
                    <strong>Failing Pass/Fail grades affect GPA</strong>
                    <Tooltip anchor="icon" text="When enabled, failing Pass/Fail classes contribute zero GP and their negative score to semester and overall calculations. This setting applies independently of the selected grade scale." />
                  </span>
                </label>
              </div>
              {highSchoolMultiTermPeriods.length ? (
                <div className="settings-rounding-options">
                  <div>
                    <h3>Overall calculation rounding <Tooltip anchor="icon" text="Choose how grades are rounded to affect the calculation of the final class letter grade." /></h3>
                  </div>
                  <div className="settings-rounding-period">
                    <label className="checkbox settings-inline-checkbox">
                      <input
                        type="checkbox"
                        checked={overallRounding.roundTermPercents === true}
                        onChange={(event) => updateOverallRounding("roundTermPercents", event.target.checked)}
                      />
                      Round term percents before calculating the overall percent
                    </label>
                    <label className="checkbox settings-inline-checkbox">
                      <input
                        type="checkbox"
                        checked={overallRounding.roundOverallPercent === true}
                        onChange={(event) => updateOverallRounding("roundOverallPercent", event.target.checked)}
                      />
                      Round the final overall percent before applying GPA cutoffs
                    </label>
                  </div>
                </div>
              ) : null}
              <div className="settings-weighted-options">
              <div className="settings-weighted-pill">
                <label className="checkbox settings-inline-checkbox">
                  <input type="checkbox" checked={appearance.weightedGpa === true} onChange={(e) => onAppearanceChange((current) => ({ ...current, weightedGpa: e.target.checked, ...(e.target.checked ? {} : { wgpaInSidebar: false }) }))} />
                  Enable Weighted GPA <Tooltip anchor="icon" text="Adds the configured GPA weight to a class's quality points when calculating WGPA." />
                </label>
                {appearance.weightedGpa === true ? <>
                  <span className="settings-weighted-divider" aria-hidden="true" />
                  <label className="checkbox settings-inline-checkbox">
                    <input type="checkbox" checked={appearance.wgpaInSidebar === true} onChange={(e) => onAppearanceChange((current) => ({ ...current, wgpaInSidebar: e.target.checked }))} />
                    WGPA in Sidebar <Tooltip anchor="icon" text="If enabled, show the Weighted GPA in the side panel along side each period instead of GPA." />
                  </label>
                </> : null}
              </div>
              </div>
              {appearance.weightedGpa === true ? (
                <section className="weight-tags-settings">
                  <table className="weight-tags-table">
                    <thead><tr><th>Weight Name</th><th>GP boost</th><th aria-label="Remove tag" /></tr></thead>
                    <tbody>
                      {weightTags.map((tag) => (
                        <tr key={tag.id}>
                          <td><input className="input" size={Math.min(Math.max(tag.name.length, 1), 25)} title={tag.name} value={tag.name} aria-label={`${tag.name} tag name`} onChange={(e) => {
                            const next = weightTags.map((item) => item.id === tag.id ? { ...item, name: e.target.value } : item);
                            applyGpa({ ...data, gpa_weight_tags: next });
                          }} onBlur={() => saveWeightTags(weightTags.map((item) => item.id === tag.id ? { ...item, name: item.name.trim() || "Weight" } : item))} /></td>
                          <td><input className="input" type="number" step="0.1" value={tag.boost} aria-label={`${tag.name} GP boost`} onChange={(e) => {
                            const next = weightTags.map((item) => item.id === tag.id ? { ...item, boost: e.target.value } : item);
                            applyGpa({ ...data, gpa_weight_tags: next });
                          }} onBlur={() => saveWeightTags(weightTags.map((item) => item.id === tag.id ? { ...item, boost: Number(item.boost) || 0 } : item))} /></td>
                          <td><button className="btn small danger" type="button" disabled={tag.id === "unweighted"} aria-label={`Delete ${tag.name}`} onClick={() => saveWeightTags(weightTags.filter((item) => item.id !== tag.id))}>×</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button className="btn small" type="button" onClick={() => saveWeightTags([...weightTags, { id: `weight-${Date.now()}`, name: "New weight", boost: 0 }])}>Add GPA weight</button>
                </section>
              ) : null}
            </div>
            <div className="settings-display-gpa-group">
              <h3>Display Options</h3>
              <div className="settings-display-gpa-fields">
                <label className="muted settings-display-gpa-field">
                  <span className="settings-field-label">Class Naming <Tooltip anchor="icon" text="Alphanumeric uses course codes such as BIO 101. Named courses uses custom names such as Biology." /></span>
                  <select className="select" value={appearance.classType || "alphanumeric"} onChange={(e) => onAppearanceChange((current) => ({ ...current, classType: e.target.value }))}>
                    <option value="alphanumeric">Alphanumeric</option>
                    <option value="named">Named courses</option>
                  </select>
                </label>
                <label className="muted settings-display-gpa-field">
                  <span className="settings-field-label">Period Labels <Tooltip anchor="icon" text="Choose the label used for reporting periods throughout the gradebook, such as Semester, Quarter, Trimester, or Term." /></span>
                  <div className={`settings-display-gpa-control${appearance.termLabelId === "custom" ? " has-custom" : ""}`}>
                    <select className="select" value={appearance.termLabelId || "semester"} onChange={(e) => onAppearanceChange((current) => ({ ...current, termLabelId: e.target.value }))}>
                      {TERM_LABEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                    {appearance.termLabelId === "custom" ? (
                      <>
                        <input className="input" value={appearance.termLabelCustom || ""} placeholder="e.g. Block" aria-label="Custom period name" onChange={(e) => onAppearanceChange((current) => ({ ...current, termLabelCustom: e.target.value }))} />
                      </>
                    ) : null}
                  </div>
                </label>
                <label className="muted settings-display-gpa-field">
                  <span className="settings-field-label">Class Labels <Tooltip anchor="icon" text="Choose the word used when displaying the unit count for classes, such as Classes, Credits, or Units." /></span>
                  <div className={`settings-display-gpa-control${appearance.creditLabelId === "other" ? " has-custom" : ""}`}>
                    <select className="select" value={appearance.creditLabelId || "credits"} onChange={(e) => onAppearanceChange((current) => ({ ...current, creditLabelId: e.target.value }))}>
                      {CREDIT_LABEL_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                    {appearance.creditLabelId === "other" ? (
                      <>
                        <input className="input" value={appearance.creditLabelCustom || ""} placeholder="e.g. Units" aria-label="Custom credit name" onChange={(e) => onAppearanceChange((current) => ({ ...current, creditLabelCustom: e.target.value }))} />
                      </>
                    ) : null}
                  </div>
                </label>
              </div>
              <div className="settings-display-gpa-options">
                <label className="checkbox settings-gpa-option">
                  <input type="checkbox" checked={data.gpa_cap === 4} onChange={(e) => updateSettings({ gpa_cap: e.target.checked ? 4 : null })} />
                  <span><strong>Cap GPA at 4.000</strong><Tooltip anchor="icon" text={`Caps semester and cumulative GPA only.${showScore ? " A+ quality points still count toward Score." : ""}`} /></span>
                </label>
                {mode === "gradebook" ? (
                  <label className="checkbox settings-gpa-option settings-show-score-option">
                    <input type="checkbox" checked={appearance.showScore !== false} onChange={(e) => onAppearanceChange((current) => ({ ...current, showScore: e.target.checked }))} />
                    <span className="settings-show-score-label"><strong>Show Score</strong><Tooltip anchor="icon" text="Target-relative Score on the GPA dashboard, course lists, and sidebar. Assignment scores stay visible." /></span>
                  </label>
                ) : null}
              </div>
              {showScore ? (
                <div className="settings-fields settings-score-options">
                  <label className="muted">
                    Target letter
                    <select className={`select letter-select ${letterClass(data.target_letter)}`} value={data.target_letter} onChange={(e) => updateSettings({ target_letter: e.target.value })}>
                      {targets.map((letter) => <option key={letter} value={letter} className={letterClass(letter)}>{letter} ({fmtGpa(targetGradePoints.get(letter))})</option>)}
                    </select>
                  </label>
                  <label className="muted">
                    Semesters remaining
                    <input className="input" type="number" min="0" step="0.5" defaultValue={data.semesters_remaining} onBlur={(e) => updateSettings({ semesters_remaining: Number(e.target.value) })} />
                  </label>
                </div>
              ) : null}
            </div>
          </div>
          <section className="semester-title-settings">
            <h3>{(data.gradebook_type || "college") === "high_school" ? "Academic periods" : "Semester titles"}</h3>
            <p className="muted settings-note">The first listed period occurs first and the last listed period occurs last.</p>
            <table className="semester-titles-table"><thead><tr><th>Name</th><th>Order</th><th aria-label="Delete" /></tr></thead><tbody>
              {(data.gradebook_type || "college") === "high_school" ? orderedAcademicPeriods.map((period, index) => {
                const key = String(period.key);
                const periodName = period.label || `Academic period ${index + 1}`;
                const draftName = academicPeriodDrafts[key] ?? periodName;
                return <tr key={key}>
                  <td><input className="input" size={Math.min(Math.max(draftName.length, 1), 25)} title={draftName} value={draftName} aria-label={`${periodName} academic period name`} onChange={(e) => {
                    const nextName = e.target.value;
                    setAcademicPeriodDrafts((current) => ({ ...current, [key]: nextName }));
                    if (normalizedName(nextName) && academicPeriods.some((other) => String(other.key) !== key && normalizedName(other.label) === normalizedName(nextName))) {
                      warning("Academic period names must be unique.");
                      return;
                    }
                    onAppearanceChange((current) => ({ ...current, highSchoolAcademicPeriods: { ...(current.highSchoolAcademicPeriods || {}), [key]: nextName } }));
                  }} onBlur={(e) => {
                    const nextName = e.target.value.trim() || periodName;
                    setAcademicPeriodDrafts((current) => ({ ...current, [key]: nextName }));
                    if (academicPeriods.some((other) => String(other.key) !== key && normalizedName(other.label) === normalizedName(nextName))) {
                      warning("Academic period names must be unique.");
                      return;
                    }
                    onAppearanceChange((current) => ({ ...current, highSchoolAcademicPeriods: { ...(current.highSchoolAcademicPeriods || {}), [key]: nextName } }));
                    onAcademicPeriodChange?.(nextName, key);
                  }} /></td>
                  <td className="period-order-actions">{index > 0 ? <button className="btn small period-order-up" type="button" aria-label={`Move ${periodName} up`} onClick={() => onAppearanceChange((current) => { const base = orderedAcademicPeriods.map((item) => String(item.key)); [base[index - 1], base[index]] = [base[index], base[index - 1]]; return { ...current, highSchoolAcademicPeriodOrder: base }; })}>↑</button> : <span className="period-order-spacer period-order-up-spacer" aria-hidden="true" />} {index < orderedAcademicPeriods.length - 1 ? <button className="btn small period-order-down" type="button" aria-label={`Move ${periodName} down`} onClick={() => onAppearanceChange((current) => { const base = orderedAcademicPeriods.map((item) => String(item.key)); [base[index], base[index + 1]] = [base[index + 1], base[index]]; return { ...current, highSchoolAcademicPeriodOrder: base }; })}>↓</button> : <span className="period-order-spacer period-order-down-spacer" aria-hidden="true" />}</td><td><button className="btn small danger" type="button" disabled={academicPeriodBusy} aria-label={`Delete ${periodName}`} onClick={() => deleteAcademicPeriod(period)}>×</button></td>
                </tr>;
              }) : (appearance.semesterTitles || []).map((item, index) => <tr key={item.id}><td><input className="input" size={Math.min(Math.max(item.name.length, 1), 25)} title={item.name} value={item.name} aria-label={`${item.name} term name`} onChange={(e) => {
                const nextName = e.target.value;
                if (RESERVED_TERM_NAMES.has(normalizedName(nextName))) {
                  warning("Term names can not be Settings or Overall.");
                  return;
                }
                if (normalizedName(nextName) && (appearance.semesterTitles || []).some((term) => term.id !== item.id && normalizedName(term.name) === normalizedName(nextName))) {
                  warning("Term names must be unique.");
                  return;
                }
                onAppearanceChange((current) => ({ ...current, semesterTitles: (current.semesterTitles || []).map((term) => term.id === item.id ? { ...term, name: nextName } : term) }));
              }} /></td><td className="period-order-actions">{index > 0 ? <button className="btn small period-order-up" type="button" aria-label={`Move ${item.name} up`} onClick={() => onAppearanceChange((current) => { const next = [...(current.semesterTitles || [])]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return { ...current, semesterTitles: next }; })}>↑</button> : <span className="period-order-spacer period-order-up-spacer" aria-hidden="true" />} {index < (appearance.semesterTitles || []).length - 1 ? <button className="btn small period-order-down" type="button" aria-label={`Move ${item.name} down`} onClick={() => onAppearanceChange((current) => { const next = [...(current.semesterTitles || [])]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return { ...current, semesterTitles: next }; })}>↓</button> : <span className="period-order-spacer period-order-down-spacer" aria-hidden="true" />}</td><td><button className="btn small danger" type="button" aria-label={`Delete ${item.name} term title`} onClick={() => deleteSemesterTitle(item)}>×</button></td></tr>)}
            </tbody></table>
            {(data.gradebook_type || "college") === "high_school" ? <form className="settings-add-period" onSubmit={(event) => { event.preventDefault(); addAcademicPeriod(); }}><input className="input" value={newAcademicPeriodName} placeholder="Academic period name" aria-label="New academic period name" onChange={(event) => setNewAcademicPeriodName(event.target.value)} /><button className="btn small" type="submit" disabled={academicPeriodBusy || !newAcademicPeriodName.trim()}>Add period</button></form> : <form className="settings-add-period" onSubmit={addSemesterTitle}><input className="input" value={newSemesterTitleName} placeholder="Semester title" aria-label="New semester title" onChange={(event) => setNewSemesterTitleName(event.target.value)} /><button className="btn small" type="submit" disabled={!newSemesterTitleName.trim()}>Add title</button></form>}
          </section>
      </section>

      {mode === "global" ? (
        <>
          <section className="panel global-recording-settings" style={{ marginTop: 16 }}>
            <h2>Grade recording</h2>
            <label className="muted settings-recording-interval" style={{ display: "block", marginTop: 14 }}>
              Grade recording interval (days) <Tooltip anchor="icon" text="How often to ask you to record class percents and semester GPA for progression charts." />
              <input
                className="input"
                style={{ display: "block", width: "min(100%, 160px)", marginTop: 6 }}
                type="number"
                min="1"
                step="1"
                defaultValue={data.recording_interval_days ?? 7}
                onBlur={(e) => {
                  const value = Math.max(1, Math.floor(Number(e.target.value) || 7));
                  e.target.value = String(value);
                  updateSettings({ recording_interval_days: value });
                }}
              />
            </label>
          </section>
          <GradebookSetupTransfer
            gradebooks={gradebooks}
            gradebookAppearances={gradebookAppearances}
            onImportComplete={async (result) => {
              await onImportedGradebookSetups?.(result);
              await refreshAll();
            }}
          />
        </>
      ) : null}

    </div>
  );
}
