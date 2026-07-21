import { DomainException } from '../../common/exceptions/domain.exception';

export class UploadVerificationFailedException extends DomainException {
  constructor() {
    super(
      'UPLOAD_VERIFICATION_FAILED',
      409,
      'Upload could not be verified in storage',
    );
  }
}
