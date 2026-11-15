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

/** Route choices are not inventory transfers. The two Filling rooms are alternatives. */
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
