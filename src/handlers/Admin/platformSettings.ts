import { Request, Response, NextFunction } from "express";
import PlatformSettings from "../../models/platformSettings";
import connecToDatabase from "../../config/db";
import { IUser } from "../../models/user";

// Get current platform settings
export const getPlatformSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUser = req.admin as IUser | undefined;
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }

    await connecToDatabase();
    const config = await PlatformSettings.getCurrentConfig();

    return res.status(200).json({
      success: true,
      data: {
        commissionPercent: config.commissionPercent,
        companyVatNumber: config.companyVatNumber || '',
        companyAddress: config.companyAddress || {},
        eInvoicing: config.eInvoicing || {},
        lastModified: config.lastModified,
        version: config.version,
      }
    });

  } catch (error: any) {
    console.error('Get platform settings error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to retrieve platform settings"
    });
  }
};

// Update platform settings
export const updatePlatformSettings = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminUser = req.admin as IUser | undefined;
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).json({ success: false, msg: "Admin access required" });
    }

    const { commissionPercent, companyVatNumber, companyAddress, eInvoicing } = req.body;

    if (typeof commissionPercent !== 'number' || !Number.isFinite(commissionPercent)) {
      return res.status(400).json({
        success: false,
        msg: "commissionPercent must be a valid number"
      });
    }

    if (commissionPercent < 0 || commissionPercent > 100) {
      return res.status(400).json({
        success: false,
        msg: "commissionPercent must be between 0 and 100"
      });
    }

    await connecToDatabase();
    const config = await PlatformSettings.getCurrentConfig();
    config.commissionPercent = commissionPercent;
    if (typeof companyVatNumber === 'string') {
      config.companyVatNumber = companyVatNumber.trim();
    }
    if (companyAddress && typeof companyAddress === 'object') {
      config.companyAddress = {
        name: typeof companyAddress.name === 'string' ? companyAddress.name.trim() : config.companyAddress?.name,
        street: typeof companyAddress.street === 'string' ? companyAddress.street.trim() : config.companyAddress?.street,
        city: typeof companyAddress.city === 'string' ? companyAddress.city.trim() : config.companyAddress?.city,
        postalCode: typeof companyAddress.postalCode === 'string' ? companyAddress.postalCode.trim() : config.companyAddress?.postalCode,
        country: typeof companyAddress.country === 'string' ? companyAddress.country.trim() : config.companyAddress?.country,
      };
    }
    if (eInvoicing && typeof eInvoicing === 'object') {
      if (eInvoicing.peppolEnabled !== undefined && typeof eInvoicing.peppolEnabled !== 'boolean') {
        return res.status(400).json({ success: false, msg: 'peppolEnabled must be a boolean' });
      }
      if (
        eInvoicing.provider !== undefined &&
        !['odoo', 'billit', 'manual'].includes(String(eInvoicing.provider))
      ) {
        return res.status(400).json({ success: false, msg: 'Invalid e-invoicing provider' });
      }
      config.eInvoicing = {
        peppolEnabled: eInvoicing.peppolEnabled === true,
        provider: ['odoo', 'billit', 'manual'].includes(eInvoicing.provider) ? eInvoicing.provider : 'manual',
        peppolParticipantId: typeof eInvoicing.peppolParticipantId === 'string'
          ? eInvoicing.peppolParticipantId.trim()
          : config.eInvoicing?.peppolParticipantId,
      };
    }
    config.lastModifiedBy = adminUser._id as any;
    await config.save();

    console.log(`⚙️  Admin ${adminUser._id} updated platform commission to ${commissionPercent}%`);

    return res.status(200).json({
      success: true,
      data: {
        commissionPercent: config.commissionPercent,
        companyVatNumber: config.companyVatNumber || '',
        companyAddress: config.companyAddress || {},
        eInvoicing: config.eInvoicing || {},
        lastModified: config.lastModified,
        version: config.version,
      }
    });

  } catch (error: any) {
    console.error('Update platform settings error:', error);
    return res.status(500).json({
      success: false,
      msg: "Failed to update platform settings"
    });
  }
};
