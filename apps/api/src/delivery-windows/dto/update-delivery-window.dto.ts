import { CreateDeliveryWindowDto } from './create-delivery-window.dto';

// Full replace, not a partial update - same shape as create, matching
// this sprint's deliberately simple "owner re-submits the whole window"
// editing model (no partial-field PATCH semantics needed yet).
export class UpdateDeliveryWindowDto extends CreateDeliveryWindowDto {}
