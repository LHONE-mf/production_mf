import {StageId} from '../types';

/**
 * Non-authoritative planning blueprint, NOT an inventory, QA or routing policy.
 * In particular, reading this data never issues, consumes, receives or moves stock.
 * Material IDs, specifications and quantities remain explicit server-side facts.
 */
export type FlowMaterial =
  | 'active-powder' | 'binder' | 'conductive-additive' | 'solvent' | 'slurry-additive'
  | 'slurry' | 'collector-foil' | 'polyimide-tape'
  | 'coated-roll' | 'calendered-roll' | 'cut-electrodes' | 'sorted-electrodes'
  | 'lithium-feedstock' | 'lithium-electrodes' | 'separator'
  | 'tabs' | 'cell-housings' | 'closures' | 'insulators'
  | 'pouch-film' | 'tab-seal-adhesive' | 'electrode-stacks' | 'wound-blocks'
  | 'assembled-dry-cells' | 'electrolyte' | 'filled-cells'
  | 'walzed-cells' | 'formed-cells';

export type DefaultHandling = 'direct' | 'room-wip';
export interface RoomFlowBlueprint {
  /** Eligible candidates only; an actual stock issue still needs authenticated approval. */
  warehouseIssueCandidates: readonly FlowMaterial[];
  /** Potential source from the previous room; never an automatic receipt. */
  upstreamInputs: readonly FlowMaterial[];
  /** Actual output must still be explicitly declared and independently counted. */
  outputs: readonly {material:FlowMaterial;handling:DefaultHandling}[];
}

/** User-approved normal flow. Central warehouse receipt is an explicit exception. */
export const MATERIAL_FLOW_BLUEPRINT = {
  [StageId.STORAGE]: {
    warehouseIssueCandidates:[],upstreamInputs:[],outputs:[],
  },
  [StageId.SLURRY]: {
    warehouseIssueCandidates:['active-powder','binder','conductive-additive','solvent','slurry-additive'],
    upstreamInputs:[],
    outputs:[{material:'slurry',handling:'direct'}],
  },
  [StageId.COATING]: {
    warehouseIssueCandidates:['slurry','collector-foil','polyimide-tape'],
    upstreamInputs:['slurry'],
    outputs:[{material:'coated-roll',handling:'direct'}],
  },
  [StageId.CALENDARING]: {
    warehouseIssueCandidates:['coated-roll'],
    upstreamInputs:['coated-roll'],
    outputs:[{material:'calendered-roll',handling:'direct'}],
  },
  [StageId.CUTTING]: {
    warehouseIssueCandidates:['calendered-roll','coated-roll'],
    upstreamInputs:['calendered-roll','coated-roll'],
    outputs:[{material:'cut-electrodes',handling:'direct'}],
  },
  [StageId.SORTING]: {
    warehouseIssueCandidates:['cut-electrodes'],
    upstreamInputs:['cut-electrodes'],
    outputs:[{material:'sorted-electrodes',handling:'direct'}],
  },
  [StageId.ASSEMBLY]: {
    warehouseIssueCandidates:[
      'sorted-electrodes','lithium-feedstock','lithium-electrodes','separator',
      'polyimide-tape','tabs','cell-housings','closures','insulators',
      'pouch-film','tab-seal-adhesive','electrode-stacks','wound-blocks',
    ],
    upstreamInputs:['sorted-electrodes'],
    outputs:[
      {material:'lithium-electrodes',handling:'room-wip'},
      {material:'electrode-stacks',handling:'room-wip'},
      {material:'wound-blocks',handling:'room-wip'},
      {material:'assembled-dry-cells',handling:'room-wip'},
    ],
  },
  [StageId.ELECTROLYTE]: {
    warehouseIssueCandidates:['assembled-dry-cells','electrolyte'],
    upstreamInputs:['assembled-dry-cells'],
    outputs:[{material:'filled-cells',handling:'direct'}],
  },
  [StageId.ELECTROLYTE_705]: {
    warehouseIssueCandidates:['assembled-dry-cells','electrolyte'],
    upstreamInputs:['assembled-dry-cells'],
    outputs:[{material:'filled-cells',handling:'direct'}],
  },
  [StageId.WALZING]: {
    warehouseIssueCandidates:['filled-cells'],
    upstreamInputs:['filled-cells'],
    outputs:[{material:'walzed-cells',handling:'direct'}],
  },
  [StageId.FORMATION]: {
    warehouseIssueCandidates:['filled-cells','walzed-cells'],
    upstreamInputs:['filled-cells','walzed-cells'],
    outputs:[{material:'formed-cells',handling:'room-wip'}],
  },
} as const satisfies Readonly<Record<StageId,RoomFlowBlueprint>>;

/** Physical handoff candidates, not inventory operations. Assembly WIP leaves its buffer only after an explicit handoff. Both Filling rooms are alternatives. */
export const DEFAULT_DIRECT_HANDOFFS = [
  {from:StageId.SLURRY,to:StageId.COATING,material:'slurry'},
  {from:StageId.COATING,to:StageId.CALENDARING,material:'coated-roll'},
  {from:StageId.CALENDARING,to:StageId.CUTTING,material:'calendered-roll'},
  {from:StageId.CUTTING,to:StageId.SORTING,material:'cut-electrodes'},
  {from:StageId.SORTING,to:StageId.ASSEMBLY,material:'sorted-electrodes'},
  {from:StageId.ASSEMBLY,to:StageId.ELECTROLYTE,material:'assembled-dry-cells'},
  {from:StageId.ASSEMBLY,to:StageId.ELECTROLYTE_705,material:'assembled-dry-cells'},
  {from:StageId.ELECTROLYTE,to:StageId.FORMATION,material:'filled-cells'},
  {from:StageId.ELECTROLYTE_705,to:StageId.WALZING,material:'filled-cells'},
  {from:StageId.WALZING,to:StageId.FORMATION,material:'walzed-cells'},
] as const;

/** One material category; actual tape SKUs/approved specifications must be chosen per use. */
export const POLYIMIDE_APPLICATIONS = [
  {room:StageId.COATING,application:'coating-lip-sealing'},
  {room:StageId.ASSEMBLY,application:'tab-insulation'},
  {room:StageId.ASSEMBLY,application:'jelly-roll-taping'},
] as const;

/** Pouch is approved as a target, but the existing Assembly CellType has not been migrated. */
export const CELL_FORMAT_PLANS = [
  {format:'cylindrical',state:'existing'},
  {format:'prismatic',state:'existing'},
  {format:'pouch',state:'planned'},
] as const;

/**
 * Approved factory allocation choices. These flags document capabilities to
 * implement; they DO NOT enable warehouse reservations or quantity mutations.
 * Only proofed server inventory operations can change warehouse stock.
 */
export const APPROVED_ALLOCATION_POLICY = {
  partialQuantitiesAllowed: true,
  multipleSourceLotsAllowed: true,
  explicitOriginalSourceRequired: true,
  blueprintCreatesStock: false,
  blueprintConsumesStock: false,
  directHandoffPostsWarehouseReceipt: false,
} as const;

/**
 * Proposals for distinct suboperations, not new app rooms or approved routes.
 * Their correct location and applicability must be confirmed per cell format.
 * "proposed" means no manufacturing behavior is implemented by this registry.
 */
export const PROPOSED_MANUFACTURING_OPERATIONS = [
  {id:'electrode-vacuum-drying',candidateRoom:StageId.ASSEMBLY,status:'proposed'},
  {id:'electrode-tab-insulation',candidateRoom:StageId.ASSEMBLY,status:'proposed'},
  {id:'jelly-roll-taping',candidateRoom:StageId.ASSEMBLY,status:'proposed'},
  {id:'pouch-cell-packing-and-primary-seal',candidateRoom:StageId.ASSEMBLY,status:'proposed'},
  {id:'electrolyte-wetting-rest',candidateRoom:StageId.ELECTROLYTE,status:'proposed'},
  {id:'post-formation-aging',candidateRoom:StageId.FORMATION,status:'proposed'},
  {id:'pouch-degassing-and-final-seal',candidateRoom:StageId.FORMATION,status:'proposed'},
  {id:'final-capacity-resistance-and-safety-testing',candidateRoom:StageId.FORMATION,status:'proposed'},
  {id:'finished-cell-grading-and-packaging',candidateRoom:StageId.FORMATION,status:'proposed'},
] as const;
