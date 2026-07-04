import { Request, Response } from "express";
import mongoose from "mongoose";
import User from "../../models/user";
import { deleteUserData } from "../../utils/deleteUserData";
import { auditLog } from "../../utils/auditLogger";
import { param, params } from "../../utils/requestParams";

export const deleteUser = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?._id;
    if (!adminId) {
      return res.status(401).json({ success: false, msg: "Admin authentication required" });
    }

    const { userId } = params(req.params);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, msg: "Invalid userId" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    if (user.role === "admin") {
      return res.status(403).json({ success: false, msg: "Cannot delete admin users" });
    }

    const targetSnapshot = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus,
    };

    await deleteUserData(user._id);

    await auditLog({
      req,
      action: 'admin.users.hard_delete',
      targetType: 'User',
      targetId: user._id,
      details: { target: targetSnapshot },
      status: 'success',
      statusCode: 200,
    });

    return res.status(200).json({ success: true, msg: `User ${user.email} and all associated data deleted` });
  } catch (error: any) {
    console.error("Delete user error:", error);
    await auditLog({
      req,
      action: 'admin.users.hard_delete',
      targetType: 'User',
      targetId: param(req.params.userId),
      status: 'failure',
      statusCode: 500,
      errorMessage: error?.message || 'unknown',
    });
    return res.status(500).json({ success: false, msg: "Failed to delete user" });
  }
};
